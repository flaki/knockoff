const SCC_ENV_TOKEN = process.env.SCC_ENV_TOKEN;
if (!SCC_ENV_TOKEN) {
  console.error("No SCC ENV token found!");
  console.log(process.env);
  process.exit(1);
}

const SCC_IDENT = "com.suborbital.acmeco";
const SCC_NS = "knockoff";
const PORT = process.env.PORT || 8080;

const APP_URL = "http://local.suborbital.network:3000";
const CONTROLPLANE_URL = "http://scc-control-plane:8081";
const BUILDER_URL = "http://scc-builder:8082";
const ATMO_URL = "http://scc-atmo:8080";

// When deploying truly-locally we use the localhost and http to expose the app,
// and will proxy builder requests
// When on CodeSandbox, CSB takes care of exposing our services on HTTPS preview URLs
const APP_PUBLIC =
  process.env.CODESANDBOX_HOST?.replace("$PORT", 3000) ?? APP_URL;
const BUILDER_PUBLIC = process.env.CODESANDBOX_HOST
  ? "https://" + process.env.CODESANDBOX_HOST.replace("$PORT", 8082)
  : APP_URL;

import { fileURLToPath } from "node:url";
const WWWROOT = fileURLToPath(new URL("../www", import.meta.url));

import sirv from "sirv";
import polka from "polka";

import bodyparser from "body-parser";

import { createProxyMiddleware } from "http-proxy-middleware";

let state = {
  todos: [],
  events: [],
};
let handlers = [];

const sendState = (res) => {
  // TODO: maybe skip sending if there was no updates?
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(state));
};

const service = polka()
  .use(sirv(WWWROOT, { maxAge: 60 }))
  .use(bodyparser.json())

  // No longer making deployments but keeping this as a deploy callback for now
  .post("/deploy", async (req, res) => {
    // Log successful deployment
    state.events.push({
      from: "subo",
      type: "rem",
      note: "New day, new me! ✨",
    });

    // Send updated state
    sendState(res);
  })

  // Fetch the app state
  // TODO: partial updates - only send state if there were new events
  // since the client's last update
  .get("/state", async (req, res) => {
    sendState(res);
  })

  // Reset persistent app state: todos, events & runnable
  .get("/reset", async (req, res) => {
    state.todos = [];
    state.events = [];

    /* TODO: should this remove all runnables? */

    res.writeHead(303, { "Content-Type": "text/plain", Location: "/" });
    res.end("OK");
  })

  // New event occurred
  .post("/mutate", async (req, res) => {
    const ev = req.body;

    // Log the event
    state.events.push(ev);

    // Update state
    if (ev.type === "del") {
      state.todos = state.todos.filter((event) => event.id !== ev.task.id);
    } else if (ev.task) {
      state.todos[ev.task.id] = ev.task;
    }

    // Pipe user events through our processing script
    if (ev.from !== "subo") {
      let evlist, evresponse;

      /* TODO: enumerate SCN functions and execute them all */
      let runnableUrl = ATMO_URL + "/com.suborbital.acmeco/knockoff/f0/v1.0.0";
      try {
        const res = await fetch(runnableUrl, {
          method: "POST",
          body: JSON.stringify(ev),
          headers: {
            Authorization: `Bearer ${SCC_ENV_TOKEN}`,
          },
        });

        evresponse = await res.text();
        evlist = JSON.parse(evresponse);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(
          `${evresponse} - HTTP ${res.status} ERROR: e.toString() @ ${runnableUrl}`
        );
        return;
      }

      console.log(evlist);

      if (Array.isArray(evlist)) {
        evlist.forEach((ev) => {
          if (ev.task) state.todos[ev.task.id] = ev.task;
          state.events.push(ev);
        });
      }
    }

    // Send updated state
    sendState(res);
  })

  // Add new runnable
  .post("/compute/create", async (req, res) => {
    const id = handlers.length;
    const fn = "f" + id;

    // Try to talk to the control plane to fetch a new editor token
    let tokenReq, data;
    try {
      tokenReq = await fetch(
        `${CONTROLPLANE_URL}/api/v1/token/${SCC_IDENT}/${SCC_NS}/${fn}`,
        {
          headers: {
            Authorization: `Bearer ${SCC_ENV_TOKEN}`,
          },
        }
      );

      data = await tokenReq.json();
    } catch (e) {
      console.log(e);
      tokenReq = { status: 503 };
    }

    if (tokenReq.status !== 200) {
      res.writeHead(tokenReq.status, { "Content-Type": "text/plain" });
      return res.end();
    }

    handlers[id] = { id, fn, data };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(handlers[id]));
  })

  // Edit a given runnable by its sequential id
  .get("/compute/editor/:id", async (req, res) => {
    const id = req.params.id ?? 0;
    const lang = req.query.t ?? "javascript";
    const handler = handlers[id];

    // The handler has not been initialized yet!
    if (!handler) {
      res.writeHead(424, { "Content-Type": "text/plain" });
      return res.end("This handler has not been initialized yet!");
    }

    // Build the editor URL and redirect
    const editorUrl = `https://editor.suborbital.network?builder=${encodeURIComponent(
      BUILDER_PUBLIC
    )}&token=${handler.data.token}&ident=${SCC_IDENT}&namespace=${SCC_NS}&fn=${
      handler.fn
    }&template=${lang}`;

    res.writeHead(303, { "Content-Type": "text/plain", Location: editorUrl });
    res.end();
  })

  // Remove runnable
  .post("/compute/delete/:id", async (req, res) => {
    // don't bother deleting the actual function, just clear the ref from handlers
    const id = 0; // for now...
    handlers = handlers.filter((i) => i.id !== id);
  })

  // We no longer need to proxy to the runnables, but expose the builder on /api/
  .use(
    "/api",
    createProxyMiddleware({
      target: BUILDER_URL,
    })
  )

  .listen(PORT, (err) => {
    if (err) throw err;
    console.log(`Webserver listening on ${PORT}`);
    console.log(`GET routes: ` + Object.keys(service.handlers.GET).join(" ; "));
    console.log(
      `POST routes: ` + Object.keys(service.handlers.POST).join(" ; ")
    );
  });

// For some reason inside docker Ctrl+C doesn't properly shut down the container without this
process.on("SIGINT", function handle(signal) {
  console.log(`Received ${signal}`);
  process.exit();
});