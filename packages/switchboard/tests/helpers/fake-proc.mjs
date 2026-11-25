// A throwaway /proc for identity tests: the files the presence probe reads
// (`sys/kernel/random/boot_id`, `<pid>/stat`, `<pid>/cmdline`, `<pid>/comm`,
// `<pid>/environ`), laid out like the kernel's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stat line with the fields the probe reads: ppid (field 4) and starttime
// (field 22). The comm sits in parentheses and may hold spaces or ')'.
export const statLine = ({ pid, comm, ppid = 1, start }) => {
  const fields = Array(52).fill('0');
  fields[0] = 'S';
  fields[1] = String(ppid);
  fields[19] = String(start);
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
};

export const makeFakeProc = ({ bootId = 'boot-aaaa' } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  const bootFile = path.join(dir, 'sys', 'kernel', 'random', 'boot_id');
  fs.mkdirSync(path.dirname(bootFile), { recursive: true });
  fs.writeFileSync(bootFile, `${bootId}\n`);
  const api = {
    dir,
    setBoot: (id) => fs.writeFileSync(bootFile, `${id}\n`),
    // argv is an array; window sets KITTY_WINDOW_ID in the environ.
    add: (pid, { comm = 'claude', start = 1000, ppid = 1, argv = [comm], window = null } = {}) => {
      const p = path.join(dir, String(pid));
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'stat'), statLine({ pid, comm, ppid, start }));
      fs.writeFileSync(path.join(p, 'comm'), `${comm}\n`);
      fs.writeFileSync(path.join(p, 'cmdline'), `${argv.join('\0')}\0`);
      fs.writeFileSync(path.join(p, 'environ'), window == null ? 'HOME=/h\0' : `HOME=/h\0KITTY_WINDOW_ID=${window}\0`);
      return { pid, start };
    },
    remove: (pid) => fs.rmSync(path.join(dir, String(pid)), { recursive: true, force: true }),
    // A pid that exists with another start time: the kernel reused the number.
    reuse: (pid, start) => api.add(pid, { start }),
    // /proc unreadable: the directory is gone.
    destroy: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return api;
};
