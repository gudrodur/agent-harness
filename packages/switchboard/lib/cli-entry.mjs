// Is this module the file the process was started with?
//
// Total by design: argv[1] is not always a file. `bun -e ... serve` sets it to the
// word `serve`, and a bun-compiled binary sets it to `/$bunfs/root/<name>`; a bare
// realpathSync on either throws ENOENT the moment a consumer imports the module.
// Both sides go through the filesystem (a symlinked directory makes the plain
// `import.meta.url` comparison false), and a path that cannot be resolved, or a
// missing argv[1], is NOT a match: "could not tell" is never "the entry point".
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!metaUrl || !argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}
