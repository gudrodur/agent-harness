// The stub OpenCode server in its own process.
//
// A test that calls the sender's synchronous reads (a listing asks the server
// for the running sessions and must have its answer before it returns) cannot
// also answer HTTP from its own event loop, which that call blocks. So these
// tests start the same stub server here, in a child, and talk to it over the
// loopback like any other client. The port is printed on stdout, one line.
//
// usage: node tests/helpers/opencode-stub-child.mjs '{"active":["ses_a"]}'
import { startStubServer } from './opencode-stub.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}');
const stub = await startStubServer(opts);
process.stdout.write(`${stub.port}\n`);
// The listening server keeps the process alive until the parent kills it.
