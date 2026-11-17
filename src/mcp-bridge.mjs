// A private, single-client Unix socket. Antigravity connects its stdio MCP
// process through macOS's nc; no TCP port or separately installed runtime.
export const MCP_LINE_LIMIT = 16 * 1024 * 1024;

export function listenUnixLines(path, onLine, onClosed = () => {}) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  let transport = null, input = null, output = null, pump = null;
  let closed = false, accepted = false, buffer = "", queued = "", writing = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const close = () => {
    if (closed) return;
    closed = true;
    queued = buffer = "";
    try { server.close(); } catch (e) {}
    try { if (pump) pump.cancel(Components.results.NS_BINDING_ABORTED); } catch (e) {}
    try { if (input) input.close(); } catch (e) {}
    try { if (output) output.close(); } catch (e) {}
    try { if (transport) transport.close(Components.results.NS_BINDING_ABORTED); } catch (e) {}
  };
  const fail = (error) => { if (!closed) { close(); onClosed(error); } };
  const drain = () => {
    if (closed || !output || writing) return;
    writing = true;
    try {
      while (queued.length) {
        let wrote;
        try { wrote = output.write(queued, Math.min(queued.length, 65536)); }
        catch (e) {
          if (e.result !== Components.results.NS_BASE_STREAM_WOULD_BLOCK) throw e;
          output.asyncWait({ onOutputStreamReady: drain }, 0, 0, Services.tm.currentThread);
          return;
        }
        if (!wrote) throw new Error("MCP socket stopped accepting data.");
        queued = queued.slice(wrote);
      }
    } catch (e) { fail(e); }
    finally { writing = false; }
  };
  try {
    server.initWithFilename(file, 0o600, 1);
    server.asyncListen({
      onSocketAccepted(socket, connection) {
        if (closed || accepted) { connection.close(Components.results.NS_BINDING_ABORTED); return; }
        accepted = true;
        transport = connection;
        try {
          input = connection.openInputStream(0, 0, 0);
          output = connection.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
          pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
          pump.init(input, 0, 0, true);
          pump.asyncRead({
            onStartRequest() {},
            onDataAvailable(request, stream, offset, count) {
              if (closed) return;
              try {
                const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
                binary.setInputStream(stream);
                buffer += decoder.decode(new Uint8Array(binary.readByteArray(count)), { stream: true });
                let nl;
                while ((nl = buffer.indexOf("\n")) >= 0) {
                  if (nl > MCP_LINE_LIMIT) throw new Error("MCP request is too large.");
                  const line = buffer.slice(0, nl);
                  buffer = buffer.slice(nl + 1);
                  if (line.trim()) onLine(line);
                }
                if (buffer.length > MCP_LINE_LIMIT) throw new Error("MCP request is too large.");
              } catch (e) { fail(e); }
            },
            onStopRequest() { fail(new Error("Antigravity's tool connection closed.")); },
          });
          drain();
        } catch (e) { fail(e); }
      },
      onStopListening() {},
    });
  } catch (e) { close(); throw e; }
  return {
    send(line) {
      if (closed) return;
      const bytes = new TextEncoder().encode(line + "\n");
      if (bytes.length > MCP_LINE_LIMIT || queued.length + bytes.length > MCP_LINE_LIMIT * 2) {
        fail(new Error("MCP response is too large.")); return;
      }
      for (let i = 0; i < bytes.length; i += 16384) queued += String.fromCharCode(...bytes.subarray(i, i + 16384));
      drain();
    },
    close,
  };
}

export async function createMcpBridge(onMessage, { listen = listenUnixLines, onClosed = () => {} } = {}) {
  // Short enough for Darwin's sockaddr_un (104 bytes), even after /tmp resolves.
  const dir = "/tmp/zai-" + crypto.randomUUID().replace(/-/g, "");
  await IOUtils.makeDirectory(dir, { permissions: 0o700, ignoreExisting: false });
  const path = dir + "/mcp";
  let pipe, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (pipe) pipe.close();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  };
  const respond = (message) => { if (!closed && pipe && message) pipe.send(JSON.stringify(message)); };
  try {
    pipe = listen(path, (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch (e) { respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
      if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
          (message.id != null && typeof message.id !== "string" && typeof message.id !== "number")) {
        respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return;
      }
      if (message.id == null) return; // notifications have no response
      if (message.method === "ping" || message.method === "server/discover") {
        respond({ jsonrpc: "2.0", id: message.id, result: {} }); return;
      }
      Promise.resolve().then(() => {
        if (!closed) return onMessage(message);
      }).then(respond, () => respond({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Tool request failed" } }));
    }, (error) => { close().catch(() => {}); onClosed(error); });
  } catch (e) { await close(); throw e; }
  return { path, mcpServer: { name: "zenai", command: "/usr/bin/nc", args: ["-U", path], env: [] }, close };
}
