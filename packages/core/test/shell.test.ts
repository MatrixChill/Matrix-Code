import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})

// The environment block is the only system-prompt surface that names the shell,
// so its Windows branch is asserted here for every platform: a model that reads
// only "Platform: win32" otherwise emits `ls -la`, `cat`, `grep`, `find`, and
// `rm -rf` command lines the shell cannot parse.
describe("shell environment line", () => {
  test("names the shell without any caution on POSIX", () => {
    expect(Shell.environmentLine("bash", "linux")).toBe("  Shell: bash")
    expect(Shell.environmentLine("zsh", "darwin")).toBe("  Shell: zsh")
  })

  test("warns that POSIX command lines are invalid in Windows PowerShell", () => {
    const line = Shell.environmentLine("powershell", "win32")
    expect(line).toContain("  Shell: powershell (")
    for (const command of ["ls -la", "cat", "grep", "find", "rm -rf"]) expect(line).toContain(command)
    expect(line).toContain("PowerShell cmdlets")
    expect(line).toContain("Glob, Grep, Read")
  })

  test("warns for PowerShell 7 the same way", () => {
    expect(Shell.environmentLine("pwsh", "win32")).toContain("PowerShell cmdlets")
  })

  test("warns that POSIX command lines are invalid in cmd.exe", () => {
    const line = Shell.environmentLine("cmd", "win32")
    expect(line).toContain("  Shell: cmd (")
    expect(line).toContain("ls -la")
    expect(line).toContain("cmd.exe commands")
  })

  test("keeps Git Bash on Windows free of the PowerShell caution", () => {
    expect(Shell.environmentLine("bash", "win32")).toBe("  Shell: bash")
  })

  test("keeps PowerShell on POSIX free of the Windows-only caution", () => {
    expect(Shell.environmentLine("pwsh", "linux")).toBe("  Shell: pwsh")
  })

  test("defaults to the shell this host resolves", () => {
    expect(Shell.environmentLine().startsWith(`  Shell: ${Shell.name(Shell.preferred())}`)).toBe(true)
  })
})
