// Stands in for the `claude` binary when real Zen runs the mod in tests
// (see real-zen.mjs): passes Claude Code's stream-json lines between the
// mod (stdin/stdout) and the test, over a local socket.
import net from "node:net";

const sock = net.connect(Number(process.env.ZENAI_RELAY_PORT), "127.0.0.1");
sock.write(JSON.stringify({ relay: "hello", args: process.argv.slice(2), pid: process.pid }) + "\n");
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on("close", () => process.exit(0));
sock.on("error", () => process.exit(1));
process.stdin.on("end", () => sock.end());
