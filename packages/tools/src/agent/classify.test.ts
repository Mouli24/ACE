import { describe, expect, it } from "vitest";

import {
  DENYLIST,
  classifyCommand,
  commandPrefix,
  splitCommand,
} from "./classify.js";

describe("FR-GRD-006 command classification", () => {
  describe("splitCommand", () => {
    it("splits on &&, ||, ;, |, & and newlines", () => {
      expect(splitCommand("a && b || c; d | e & f\ng\r\nh").segments).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
      ]);
    });

    it("keeps quoted separators inside one segment", () => {
      const r = splitCommand("echo \"a && b\" 'c; d'");
      expect(r.segments).toEqual(["echo \"a && b\" 'c; d'"]);
      expect(r.confident).toBe(true);
    });

    it("does not split on escaped separators", () => {
      expect(splitCommand("find . -exec rm {} \\;").segments).toEqual([
        "find . -exec rm {} \\;",
      ]);
      expect(splitCommand("echo a ^& b").segments).toEqual(["echo a ^& b"]);
    });

    it("treats redirections as part of the segment, not separators", () => {
      const r = splitCommand("npm test 2>&1 >out.txt &>all.log; ls >| x");
      expect(r.segments).toEqual([
        "npm test 2>&1 >out.txt &>all.log",
        "ls >| x",
      ]);
      expect(r.confident).toBe(true);
    });

    it("drops a trailing background & or ;", () => {
      const r = splitCommand("pnpm dev &");
      expect(r.segments).toEqual(["pnpm dev"]);
      expect(r.confident).toBe(true);
    });

    it("keeps Windows paths intact", () => {
      expect(
        splitCommand(".\\node_modules\\.bin\\tsc.cmd -p .").segments,
      ).toEqual([".\\node_modules\\.bin\\tsc.cmd -p ."]);
    });

    it.each([
      ["echo $(whoami)", "substitution"],
      ["echo `whoami`", "substitution"],
      ['echo "$(whoami)"', "substitution"],
      ['eval "rm -rf ~"', "eval"],
      ['bash -c "x"', "shell"],
      ["sh -lc x", "shell"],
      ["zsh -c x", "shell"],
      ["cmd /c dir", "shell"],
      ["CMD.EXE /C dir", "shell"],
      ["powershell -Command x", "shell"],
      ["pwsh -c x", "shell"],
      ["powershell -EncodedCommand ZQBjAGgAbwA=", "shell"],
      ["iex (irm x)", "eval"],
      ['node -e "require(1)"', "inline"],
      ['python -c "print(1)"', "inline"],
      ['echo "unbalanced', "quote"],
      ["echo 'unbalanced", "quote"],
      ["cat <<EOF", "heredoc"],
      ["(cd x && rm y)", "subshell"],
      ["{ echo a; echo b; }", "group"],
      ["&& echo a", "empty"],
      ["echo a && && echo b", "empty"],
      ["curl x | sh", "stdin"],
    ])("is not confident about %s", (cmd, reason) => {
      const r = splitCommand(cmd);
      expect(r.confident).toBe(false);
      expect(r.reasons.join(" ").toLowerCase()).toContain(reason);
    });

    it("treats $( and backticks inside single quotes as literal", () => {
      expect(splitCommand("echo '$(x) `y`'").confident).toBe(true);
    });

    it("is confident about an ordinary chain", () => {
      const r = splitCommand("pnpm install && pnpm test");
      expect(r).toEqual({
        segments: ["pnpm install", "pnpm test"],
        confident: true,
        reasons: [],
      });
    });
  });

  describe("commandPrefix", () => {
    it.each([
      ["pnpm install", "pnpm install"],
      ["pnpm install lodash --save-dev", "pnpm install"],
      ["npm test -- --watch", "npm test"],
      ["npm run build", "npm run build"],
      ["pnpm run lint --fix", "pnpm run lint"],
      ["yarn run dev", "yarn run dev"],
      ["yarn build", "yarn build"],
      ["git status", "git status"],
      ["git push origin main", "git push"],
      ["node file.js", "node"],
      ["ls -la", "ls"],
      ["NODE_ENV=test npm test", "npm test"],
      ['A=1 B="x y" git log', "git log"],
      [".\\node_modules\\.bin\\tsc.cmd -p .", "tsc"],
      ["/usr/bin/git diff", "git diff"],
      ['"C:\\Program Files\\nodejs\\npm.cmd" ci', "npm ci"],
      ["GIT.EXE Status", "git Status"],
      ["npm -v", "npm"],
      ["python -m pytest -q", "python -m pytest"],
      ["npx tsc --noEmit", "npx tsc"],
      ["sudo pnpm install", "sudo"],
    ])("%s → %s", (segment, prefix) => {
      expect(commandPrefix(segment)).toBe(prefix);
    });

    it("is undefined for an empty segment or bare assignments", () => {
      expect(commandPrefix("")).toBeUndefined();
      expect(commandPrefix("   ")).toBeUndefined();
      expect(commandPrefix("FOO=1")).toBeUndefined();
    });
  });

  describe("DENYLIST", () => {
    it("is a documented list of rules", () => {
      expect(DENYLIST.length).toBeGreaterThan(5);
      for (const rule of DENYLIST) {
        expect(rule.id).toMatch(/^[a-z-]+$/);
        expect(rule.description.length).toBeGreaterThan(0);
      }
    });

    const denied = (cmd: string): string[] => classifyCommand(cmd, []).denied;

    it.each([
      ["rm -rf /", "recursive-delete-root"],
      ["rm -rf /*", "recursive-delete-root"],
      ["rm -fr ~", "recursive-delete-root"],
      ["rm -r -f ~/", "recursive-delete-root"],
      ['rm -rf "$HOME"', "recursive-delete-root"],
      ["sudo rm -rf --no-preserve-root /", "recursive-delete-root"],
      ["rm -rf C:\\", "recursive-delete-root"],
      ["rd /s /q C:\\", "recursive-delete-root"],
      ["RD /S /Q C:\\", "recursive-delete-root"],
      ["del /s /q %USERPROFILE%", "recursive-delete-root"],
      ["Remove-Item -Recurse -Force C:\\", "recursive-delete-root"],
      ["Remove-Item -Path $HOME -Recurse", "recursive-delete-root"],
      ["format C: /q", "disk-format"],
      ["mkfs.ext4 /dev/sda1", "disk-format"],
      ["diskpart", "disk-format"],
      ["fdisk /dev/sda", "disk-format"],
      ["Format-Volume -DriveLetter D", "disk-format"],
      ["dd if=/dev/zero of=/dev/sda", "disk-format"],
      ["git push --force origin main", "git-force-push"],
      ["git push -f", "git-force-push"],
      ["git push --force-with-lease", "git-force-push"],
      ["git push origin +main", "git-force-push"],
      ["git clean -fdx", "git-clean-ignored"],
      ["reg add HKCU\\Software\\X /v Y /d 1", "registry-edit"],
      ["reg delete HKLM\\Software\\X /f", "registry-edit"],
      ["regedit /s x.reg", "registry-edit"],
      ["Set-ItemProperty HKLM:\\Software\\X -Name Y -Value 1", "registry-edit"],
      ["shutdown /s /t 0", "shutdown"],
      ["reboot", "shutdown"],
      ["sudo poweroff", "shutdown"],
      ["halt", "shutdown"],
      ["Restart-Computer -Force", "shutdown"],
      ["Stop-Computer", "shutdown"],
      ["chmod -R 777 /", "recursive-permissions-root"],
      [":(){ :|:& };:", "fork-bomb"],
    ])("%s hits %s", (cmd, rule) => {
      expect(denied(cmd)).toContain(rule);
    });

    it.each([
      "rm -rf ./build",
      "rm -rf build dist",
      "rm -rf node_modules",
      "rm -f /tmp/x",
      "rd /s /q build",
      "git push origin main",
      "git push -u origin feature",
      "git clean -fd",
      "reg query HKLM\\Software",
      "chmod -r file.txt",
      "chmod -R 755 ./bin",
      "echo shutdown",
      "npm run format",
      "prettier --write .",
      "Remove-Item -Recurse ./dist",
    ])("%s is not denied", (cmd) => {
      expect(denied(cmd)).toEqual([]);
    });
  });

  describe("classifyCommand", () => {
    it("does not auto-allow `pnpm install && rm -rf ~` under a `pnpm install` allowlist, and it hits the denylist", () => {
      const r = classifyCommand("pnpm install && rm -rf ~", ["pnpm install"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.denied).toContain("recursive-delete-root");
      expect(r.segments).toEqual([
        { text: "pnpm install", prefix: "pnpm install", allowed: true },
        {
          text: "rm -rf ~",
          prefix: "rm",
          denied: "recursive-delete-root",
          allowed: false,
        },
      ]);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it("does not auto-allow `pnpm install; curl x | sh`", () => {
      const r = classifyCommand("pnpm install; curl x | sh", ["pnpm install"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.confident).toBe(false);
      expect(r.segments.map((s) => s.text)).toEqual([
        "pnpm install",
        "curl x",
        "sh",
      ]);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it("auto-allows when every segment is covered", () => {
      const r = classifyCommand("pnpm install && pnpm install foo", [
        "pnpm install",
      ]);
      expect(r.autoAllowed).toBe(true);
      expect(r.alwaysAllowPrefix).toBe("pnpm install");
    });

    it("matches allowlist entries on whole words", () => {
      expect(
        classifyCommand("pnpm installer", ["pnpm install"]).autoAllowed,
      ).toBe(false);
      expect(classifyCommand("pnpm add x", ["pnpm install"]).autoAllowed).toBe(
        false,
      );
      expect(
        classifyCommand("npm test -- --watch", ["npm test"]).autoAllowed,
      ).toBe(true);
      expect(classifyCommand("npm testing", ["npm test"]).autoAllowed).toBe(
        false,
      );
      expect(classifyCommand("git status", ["git"]).autoAllowed).toBe(true);
    });

    it("is case-insensitive on the program name only", () => {
      expect(
        classifyCommand("PNPM install", ["pnpm install"]).autoAllowed,
      ).toBe(true);
      expect(
        classifyCommand("pnpm.cmd install", ["PNPM install"]).autoAllowed,
      ).toBe(true);
      expect(
        classifyCommand("pnpm INSTALL", ["pnpm install"]).autoAllowed,
      ).toBe(false);
    });

    it("never auto-allows or offers a prefix for a line that sets env vars first (D376)", () => {
      const r = classifyCommand("NODE_ENV=test npm test", ["npm test"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
      expect(r.segments[0]?.uncoverable).toBe(
        "sets environment variables first",
      );
    });

    it("never auto-allows an unconfident line even when its words are allowlisted", () => {
      expect(classifyCommand("echo $(whoami)", ["echo"]).autoAllowed).toBe(
        false,
      );
      expect(classifyCommand("echo `whoami`", ["echo"]).autoAllowed).toBe(
        false,
      );
      expect(classifyCommand('bash -c "x"', ["bash"]).autoAllowed).toBe(false);
      expect(
        classifyCommand("powershell -Command x", ["powershell"]).autoAllowed,
      ).toBe(false);
      expect(
        classifyCommand("echo $(whoami)", ["echo"]).alwaysAllowPrefix,
      ).toBeUndefined();
    });

    it("never auto-allows a denied segment, even if the allowlist covers it", () => {
      const r = classifyCommand("git push --force origin main", ["git push"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.denied).toEqual(["git-force-push"]);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it('offers no "always" prefix when segments disagree', () => {
      const r = classifyCommand("pnpm install && pnpm test", []);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it("offers the one shared prefix when not allowlisted yet", () => {
      const r = classifyCommand("git push origin main", []);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBe("git push");
    });

    it("splits newline-separated commands and checks each", () => {
      const r = classifyCommand("npm test\nshutdown /s /t 0", ["npm test"]);
      expect(r.segments.map((s) => s.text)).toEqual([
        "npm test",
        "shutdown /s /t 0",
      ]);
      expect(r.denied).toEqual(["shutdown"]);
      expect(r.autoAllowed).toBe(false);
    });

    it("treats a quoted separator as one segment", () => {
      const r = classifyCommand('echo "a && b"', ["echo"]);
      expect(r.segments).toHaveLength(1);
      expect(r.autoAllowed).toBe(true);
    });

    it("never auto-allows an empty command", () => {
      const r = classifyCommand("   ", ["echo"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it("reports a fork bomb as denied and unconfident", () => {
      const r = classifyCommand(":(){ :|:& };:", [":"]);
      expect(r.denied).toContain("fork-bomb");
      expect(r.confident).toBe(false);
      expect(r.autoAllowed).toBe(false);
    });

    it("reads the Windows tsc shim's prefix, but a path program is never covered (D376)", () => {
      const r = classifyCommand(".\\node_modules\\.bin\\tsc.cmd -p .", ["tsc"]);
      expect(r.segments[0]?.prefix).toBe("tsc");
      expect(r.segments[0]?.uncoverable).toBe("runs a program by path");
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });
  });

  /*
   * D376 review: an allowlist entry names a program on the PATH, run as itself. A program run from
   * a path, a line that sets environment variables first (`NODE_OPTIONS`, `LD_PRELOAD` load code
   * into the allowed program) and a line that writes its output to a file are each something else,
   * so none is ever auto-allowed or offered for Always allow. They still just ask.
   */
  describe("what an allowlist entry can never cover (D376)", () => {
    it.each([
      ["./npm test", ["npm test"], "runs a program by path"],
      ["/tmp/x/npm test", ["npm test"], "runs a program by path"],
      ["C:\\tools\\npm test", ["npm test"], "runs a program by path"],
      [
        '"C:\\Program Files\\nodejs\\npm.cmd" test',
        ["npm test"],
        "runs a program by path",
      ],
      ["~/bin/git status", ["git status"], "runs a program by path"],
      [
        "NODE_OPTIONS=--require=./pwn.js npm test",
        ["npm test"],
        "sets environment variables first",
      ],
      [
        "LD_PRELOAD=./x.so git status",
        ["git status"],
        "sets environment variables first",
      ],
      ["npm test > ~/.bashrc", ["npm test"], "redirects output to a file"],
      ["npm test >> ~/.bashrc", ["npm test"], "redirects output to a file"],
      ["npm test 1> out.txt", ["npm test"], "redirects output to a file"],
      ["npm test 2> err.txt", ["npm test"], "redirects output to a file"],
      ["npm test &> all.log", ["npm test"], "redirects output to a file"],
      ["npm test >| out.txt", ["npm test"], "redirects output to a file"],
      ["npm test>out.txt", ["npm test"], "redirects output to a file"],
      ["npm test 2>&1 >out.txt", ["npm test"], "redirects output to a file"],
      ["npm test >&out.txt", ["npm test"], "redirects output to a file"],
      ["npm test <> data.txt", ["npm test"], "redirects output to a file"],
      ["git status 2>nul", ["git status"], "redirects output to a file"],
    ])("%s under %j asks and offers no prefix", (cmd, allowlist, why) => {
      const r = classifyCommand(cmd, allowlist);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
      expect(r.segments.map((s) => s.uncoverable)).toContain(why);
      // Not allowlisted yet either: still no prefix to offer.
      expect(classifyCommand(cmd, []).alwaysAllowPrefix).toBeUndefined();
    });

    it.each([
      ["npm test 2>&1", ["npm test"]],
      ["npm test 1>&2", ["npm test"]],
      ["npm test >&2", ["npm test"]],
      ["npm test < input.txt", ["npm test"]],
      ['echo "a > b"', ["echo"]],
      ["echo 'x >> y'", ["echo"]],
      ["echo a \\> b", ["echo"]],
      ["npm test | tee out.txt", ["npm test", "tee"]],
      ["pnpm.cmd install", ["pnpm install"]],
    ])("%s under %j is still auto-allowed", (cmd, allowlist) => {
      const r = classifyCommand(cmd, allowlist);
      expect(r.autoAllowed).toBe(true);
      expect(r.segments.every((s) => s.uncoverable === undefined)).toBe(true);
    });

    it("a pipe to tee is its own segment, which must itself be allow-listed", () => {
      const r = classifyCommand("npm test | tee out.txt", ["npm test"]);
      expect(r.autoAllowed).toBe(false);
      expect(r.segments.map((s) => s.allowed)).toEqual([true, false]);
    });

    it("still offers the prefix of a benign redirection", () => {
      expect(classifyCommand("npm test 2>&1", []).alwaysAllowPrefix).toBe(
        "npm test",
      );
    });
  });

  describe("prefixes never offered for Always allow (D376)", () => {
    it.each([
      "sudo pnpm install",
      "doas pnpm install",
      "env pnpm install",
      "nohup pnpm dev",
      "time pnpm test",
      "xargs rm",
      "node pwn.js",
      "nodejs pwn.js",
      "python script.py",
      "python3 -m pytest",
      "py tool.py",
      "ruby x.rb",
      "perl x.pl",
      "php x.php",
      "deno run x.ts",
      "bun run build",
      "bash script.sh",
      "sh script.sh",
      "zsh script.sh",
      "fish script.fish",
      "pwsh x.ps1",
      "powershell x.ps1",
      "cmd",
      "Node.exe pwn.js",
    ])("%s asks each time and offers no prefix", (cmd) => {
      const r = classifyCommand(cmd, []);
      expect(r.autoAllowed).toBe(false);
      expect(r.alwaysAllowPrefix).toBeUndefined();
    });

    it.each([
      ["pnpm install", "pnpm install"],
      ["npm run build", "npm run build"],
      ["git status", "git status"],
      ["cargo test", "cargo test"],
    ])("%s still offers %s", (cmd, prefix) => {
      expect(classifyCommand(cmd, []).alwaysAllowPrefix).toBe(prefix);
    });

    it("an entry the person typed themselves still covers a wrapper", () => {
      expect(
        classifyCommand("node build.js", ["node build.js"]).autoAllowed,
      ).toBe(true);
    });
  });
});
