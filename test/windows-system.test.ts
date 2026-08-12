import { expect, test } from "bun:test";

import { resolveWindowsSystemExecutable } from "../src/shared/windows-system.ts";

test("Windows security executables resolve only below an absolute System32 root", () => {
  const seen: string[] = [];
  const exists = (path: string) => { seen.push(path); return true; };
  expect(resolveWindowsSystemExecutable("net.exe", "C:\\Windows", exists)).toBe("C:\\Windows\\System32\\net.exe");
  expect(resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Windows", exists))
    .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(seen).toHaveLength(2);

  for (const root of [undefined, "", ".", "relative", "\\server\\share", "C:\\Windows\0evil"]) {
    expect(resolveWindowsSystemExecutable("net.exe", root, exists)).toBeNull();
  }
  for (const relative of ["..\\evil.exe", "C:\\repo\\net.exe", "\\\\server\\net.exe", ""]) {
    expect(resolveWindowsSystemExecutable(relative, "C:\\Windows", exists)).toBeNull();
  }
});

test("Windows security executable resolution fails closed when the inbox file is absent", () => {
  expect(resolveWindowsSystemExecutable("icacls.exe", "D:\\Win", () => false)).toBeNull();
});
