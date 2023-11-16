const SQLite = require("better-sqlite3");
const WebSocket = require("ws");
const { validateEvent, nip19 } = require("nostr-tools");
const auth = require("../auth.js");
const nip42 = require("../nip42.js");

let { relays, tmp_store, log_about_relays, authorized_keys, private_keys } = require("../config");

const socks = new Set();
const sess = new SQLite((process.env.IN_MEMORY || tmp_store != "disk") ? null : (__dirname + "/../.temporary.db"));
const csess = new Map();

const pendingEOSE = new Map(); // per sessID
const reqLimit = new Map(); // per sessID
const searchQuery = new Map(); // per sessID

// Handle database....
sess.unsafeMode(true);

// Temporary database.
sess.exec("CREATE TABLE IF NOT EXISTS sess (cID TEXT, subID TEXT, filter TEXT);");
sess.exec("CREATE TABLE IF NOT EXISTS events (cID TEXT, subID TEXT, eID TEXT);"); // To prevent transmitting duplicates
sess.exec("CREATE TABLE IF NOT EXISTS recentEvents (cID TEXT, data TEXT);");

authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

// CL - User socket
module.exports = (ws, req) => {
  let authKey = null;
  let authorized = true;

  ws.id = process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size;

  if (authorized_keys?.length) {
    authKey = Date.now() + Math.random().toString(36);
    authorized = false;
    ws.send(JSON.stringify(["AUTH", authKey]));
  }

  console.log(process.pid, `->- ${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} connected as ${ws.id}`);
  ws.on("message", data => {
    try {
      data = JSON.parse(data);
    } catch {
      return ws.send(
        JSON.stringify(["NOTICE", "error: bad JSON."])
      )
    }

    switch (data[0]) {
      case "EVENT":
        if (!validateEvent(data[1])) return ws.send(JSON.stringify(["NOTICE", "error: invalid event"]));
        if (data[1].kind == 22242) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: kind 22242"]));
        if (!authorized) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "unauthorized."]));
        sess.prepare("INSERT INTO recentEvents VALUES (?, ?);").run(ws.id, JSON.stringify(data));
        bc(data);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["NOTICE", "expected filter to be obj, instead gives the otherwise."]));
        if (!authorized) return ws.send(JSON.stringify(["NOTICE", "unauthorized."]));
        data[1] = ws.id + ":" + data[1];
        // eventname -> 1_eventname
        bc(data);
        sess.prepare("INSERT INTO sess VALUES (?, ?, ?);").run(ws.id, data[1], JSON.stringify(data[2]));
        if (data[2]?.search) searchQuery.set(data[1], data[2]?.search);
        if (data[2]?.limit < 1) return ws.send(JSON.stringify(["EOSE", data[1].split(":")[1]]));
        pendingEOSE.set(data[1], 0);
        reqLimit.set(data[1], data[2]?.limit);
        break;
      case "CLOSE":
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (!authorized) return ws.send(JSON.stringify(["NOTICE", "unauthorized."]));
        data[1] = ws.id + ":" + data[1];
        bc(data);
        pendingEOSE.delete(data[1]);
        reqLimit.delete(data[1]);
        searchQuery.delete(data[1]);
        sess.prepare("DELETE FROM sess WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        sess.prepare("DELETE FROM events WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        break;
      case "AUTH":
        if (auth(authKey, authorized, authorized_keys, data[1], ws, req)) {
          ws.pubkey = data[1].pubkey;
          authorized = true;
        }
        break;
      default:
        console.warn(process.pid, "---", "Unknown command:", data.join(" "));
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.");
    csess.delete(ws.id);
    for (i of sess.prepare("SELECT subID FROM sess WHERE cID = ?").iterate(ws.id)) {
      bc(["CLOSE", i.subID]);
      pendingEOSE.delete(i.subID);
      reqLimit.delete(i.subID);
      searchQuery.delete(i.subID);
    }

    sess.prepare("DELETE FROM sess WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM events WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM recentEvents WHERE cID = ?;").run(ws.id);
  });

  csess.set(ws.id, ws);
}

// WS - Broadcast message to every existing sockets
function bc(msg) {
  for (sock of socks) {
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  }
}

// WS - Sessions
function newConn(addr) {
  const relay = new WebSocket(addr, {
    headers: {
      "User-Agent": "Bostr; The nostr relay bouncer; https://github.com/Yonle/bostr"
    }
  });

  relay.on('open', _ => {
    socks.add(relay); // Add this socket session to [socks]
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.log(process.pid, "---", `[${socks.size}/${relays.length}]`, relay.url, "is connected");

    for (i of sess.prepare("SELECT data FROM recentEvents;").iterate()) {
      if (relay.readyState >= 2) break;
      relay.send(i.data);
    }

    for (i of sess.prepare("SELECT subID, filter FROM sess").iterate()) {
      if (relay.readyState >= 2) break;
      relay.send(JSON.stringify(["REQ", i.subID, JSON.parse(i.filter)]));
    }
  });

  relay.on('message', data => {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return console.error(error);
    }

    switch (data[0]) {
      case "EVENT": {
        const subID = data[1];
        const args = subID.split(":")
        /*
            args[0]                 -> Client socket ID (bouncer -> client)
            args.slice(1).join(":") -> Actual subscription ID that socket client requested.
         */
        const cID = args[0];
        const sID = args.slice(1).join(":");
        const NotInSearchQuery = searchQuery.has(subID) && !data[2]?.content?.toLowerCase()?.includes(searchQuery.get(subID).toLowerCase());

        if (NotInSearchQuery) return;
        if (!sess.prepare("SELECT * FROM sess WHERE cID = ? AND subID = ?;").get(cID, subID)) return relay.send(JSON.stringify(["CLOSE", subID]));
        if (sess.prepare("SELECT * FROM events WHERE cID = ? AND subID = ? AND eID = ?;").get(cID, subID, data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        sess.prepare("INSERT INTO events VALUES (?, ?, ?);").run(cID, subID, data[2]?.id);
        data[1] = sID;
        csess.get(cID)?.send(JSON.stringify(data));

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        if (!pendingEOSE.has(subID)) return;

        let remainingEvents = reqLimit.get(subID);

        if (remainingEvents) {
          remainingEvents--;
          reqLimit.set(subID, remainingEvents);
        }

        if (remainingEvents < 1) {
          // Once there are no remaining event, Do the instructed above.
          csess.get(cID)?.send(JSON.stringify(["EOSE", sID]));
          pendingEOSE.delete(subID);
          reqLimit.delete(subID);
        }

        break;
      }
      case "EOSE": {
        const subID = data[1];
        if (!pendingEOSE.has(subID)) return;
        pendingEOSE.set(subID, pendingEOSE.get(subID) + 1);
        if (pendingEOSE.get(subID) < relays.length) return;
        const args = subID.split(":")
        /*
            args[0]                 -> Client socket ID (bouncer -> client)
            args.slice(1).join(":") -> Actual subscription ID that socket client requested.
         */
        const cID = args[0];
        const sID = args.slice(1).join(":");

        csess.get(cID)?.send(JSON.stringify(["EOSE", sID]));
        pendingEOSE.delete(subID);
        reqLimit.delete(subID);
        break;
      }
      case "AUTH": {
        if (!private_keys || typeof(data[1]) !== "string") return;
        const pubkey = authorized_keys[0];
        nip42(relay, pubkey, private_keys[pubkey], data[1]);
        break;
      }
    }
  });

  relay.on('error', _ => {
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.error(process.pid, "-!-", relay.url, _.toString());
  });
  relay.on('close', _ => {
    socks.delete(relay) // Remove this socket session from [socks] list
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.log(process.pid, "-!-", `[${socks.size}/${relays.length}]`, "Disconnected from", relay.url);

    setTimeout(_ => newConn(addr), 5000); // As a bouncer server, We need to reconnect.
  });
}

relays.forEach(newConn);
