import { describe, expect, test } from "bun:test";
import { KbError } from "../cli/note.ts";
import { matchesCommand, matchesError, mayMatchCommand, parseTrigger, pathWords, readTriggers, requireTriggers, simpleCommands } from "../cli/trigger.ts";

/** True when a `cmd` trigger with these words fires for the command line, as the hook decides it. */
const fires = (trigger: string, command: string) => {
  const words = trigger.split(" ");
  const hit = matchesCommand(words, simpleCommands(command));
  // The cheap test on the text must never rule out a command that matches.
  if (hit) expect(mayMatchCommand(words, command)).toBe(true);
  return hit;
};

describe("a cmd trigger and a command line", () => {
  const MATCH: [trigger: string, command: string][] = [
    ["pkill -f", "pkill -f node"],
    ["pkill -f", "sudo pkill -9 -f x"],
    ["pkill -f", "a && pkill -f x"],
    ["pkill -f", "a || pkill -f x"],
    ["pkill -f", "a; pkill -f x"],
    ["pkill -f", "ps aux | pkill -f x"],
    ["pkill -f", "sleep 1 & pkill -f x"],
    ["pkill -f", "echo start\npkill -f x"],
    ["pkill -f", "echo $(pkill -f x)"],
    ["pkill -f", 'echo "pids: $(pkill -f x)"'],
    ["pkill -f", "echo `pkill -f x`"],
    ["pkill -f", "(cd /tmp && pkill -f x)"],
    ["pkill -f", "{ pkill -f x; }"],
    ["pkill -f", "if pkill -f x; then echo gone; fi"],
    ["pkill -f", "for p in a b; do pkill -f $p; done"],
    ["pkill -f", "! pkill -f x"],
    ["pkill -f", "/usr/bin/pkill -f x"],
    ["pkill -f", "FOO=1 BAR=2 pkill -f x"],
    ["pkill -f", "pkill -f x 2>&1 | tee log"],
    ["pkill -f", "pkill 2>/dev/null -f x"],
    ["pkill -f", "time pkill -f x"],
    ["pkill -f", "timeout 5 pkill -f x"],
    ["pkill -f", "sudo -u root env A=1 pkill -f x"],
    ["pkill -f", "pgrep x | xargs -n1 pkill -f"],
    ["pkill -f", "find . -name '*.pid' -exec pkill -f {} \\;"],
    ["pkill -f", "bash -c 'sleep 1 && pkill -f x'"],
    ["pkill -f", 'sh -c "pkill -f x"'],
    ["pkill -f", "ssh build.example.com 'pkill -f x'"],
    ["pkill -f", "ssh build.example.com pkill -f x"],
    ["pkill -f", "eval 'pkill -f x'"],
    ["pkill -f", "pkill \\\n  -f x"],
    ["pkill -f", "cat <<EOF\nsome text\nEOF\npkill -f x"],
    ["pkill -f", "diff <(pkill -f x) /dev/null"],
    ["pkill -f", "'pkill' -f x"],
    ["git push --force", "git push origin main --force"],
    ["git push --force", "git -C /home/user/app push --force=yes origin"],
    ["git push --force", "git push --force-with-lease && git push --force"],
    ["scripts/live.sh up", "./scripts/live.sh up"],
    ["scripts/live.sh up", "/home/user/app/scripts/live.sh up --port 1"],
    ["rm -rf", "rm -rf build"],
    ["zorp", "zorp"],
  ];
  for (const [trigger, command] of MATCH) test(`"${trigger}" fires for: ${JSON.stringify(command)}`, () => expect(fires(trigger, command)).toBe(true));

  const NO_MATCH: [trigger: string, command: string, why: string][] = [
    ["pkill -f", 'echo "pkill -f"', "a quoted argument is data"],
    ["pkill -f", "echo pkill -f", "pkill is not the command word"],
    ["pkill -f", "grep -rn 'pkill -f' .", "a quoted argument is data"],
    ["pkill -f", "git commit -m 'stop the pkill -f call'", "a quoted argument is data"],
    ["pkill -f", "kb search pkill -f", "pkill is an argument"],
    ["pkill -f", "pkill node", "the second word is missing"],
    ["pkill -f", "pkill -fx node", "-f is inside a longer word"],
    ["pkill -f", "xpkill -f node", "pkill is inside a longer word"],
    ["pkill -f", "pkillall -f node", "pkill is inside a longer word"],
    ["pkill -f", "pkill x; ls -f", "the two words are in two simple commands"],
    ["pkill -f", "ls -f && pkill x", "the words are in the wrong order, in two commands"],
    ["pkill -f", "tar -f a.tar pkill", "the words are in the wrong order"],
    ["pkill -f", "# pkill -f x", "a comment"],
    ["pkill -f", "ls # then pkill -f x", "a comment"],
    ["pkill -f", "cat > notes.md <<'EOF'\npkill -f kills the shell\nEOF", "the body of a heredoc is data"],
    ["pkill -f", "kb add --json <<'KB_NOTE'\n{\"title\": \"x\", \"body\": \"pkill -f x\"}\nKB_NOTE", "the body of a heredoc is data"],
    ["pkill -f", "cat <<-EOF\n\tpkill -f x\n\tEOF\necho done", "the body of a heredoc is data"],
    ["pkill -f", "bash -c \"echo 'pkill -f'\"", "a quoted argument inside the script is data"],
    ["pkill -f", "X='pkill -f' ls", "an assignment is data"],
    ["pkill -f", "printf '%s' \"$(echo 'pkill -f')\"", "a quoted argument is data"],
    ["pkill -f", "cat <<< 'pkill -f'", "a here-string is data"],
    ["git push --force", "git push --force-with-lease", "--force is inside a longer word"],
    ["git push --force", "git commit -m push --amend", "the last word is missing"],
    ["rm -rf", "rm -fr build", "-rf and -fr are two words: give one trigger for each"],
    ["rm -rf", "trim -rf", "rm is inside a longer word"],
    ["scripts/live.sh up", "myscripts/live.sh up", "scripts is inside a longer folder name"],
    ["zorp", "echo zorp", "zorp is an argument"],
    ["zorp", "zorp-cli run", "zorp is inside a longer word"],
  ];
  for (const [trigger, command, why] of NO_MATCH) test(`"${trigger}" does not fire for: ${JSON.stringify(command)} (${why})`, () => expect(fires(trigger, command)).toBe(false));

  test("a line is cut into simple commands, with the quotes taken off the words", () => {
    expect(simpleCommands("A=1 git -C 'my repo' push && echo \"a  b\" | wc -l; ls")).toEqual([["A=1", "git", "-C", "my repo", "push"], ["echo", "a  b"], ["wc", "-l"], ["ls"]]);
    expect(simpleCommands("echo hi > out.txt 2>&1 &")).toEqual([["echo", "hi", "out.txt", "2", "1"]]);
    expect(simpleCommands("cat <<'EOF' | wc\n$(rm -rf /)\nEOF\nls")).toEqual([["cat"], ["wc"], ["ls"]]);
    expect(simpleCommands("")).toEqual([]);
  });

  test("odd input ends, and never throws", () => {
    for (const command of ["echo 'open", 'echo "open', "echo $(open", "echo `open", "cat <<EOF\nno end", "a \\", "((((", "))))", "<<", "$(".repeat(40)]) {
      expect(() => simpleCommands(command)).not.toThrow();
    }
    // A very long command is cut, so a file written through a heredoc costs no time.
    expect(simpleCommands(`echo ${"x".repeat(300_000)} && pkill -f x`).some((words) => words[0] === "pkill")).toBe(false);
  });

  test("the words of a command that can be paths", () => {
    expect(pathWords(simpleCommands("sed -n 1,3p src/pay.ts && git show HEAD:docs/a.md --output=out/x.txt"))).toEqual(["sed", "-n", "1", "3p", "src/pay.ts", "git", "show", "HEAD", "docs/a.md", "--output", "out/x.txt"]);
  });
});

describe("an err trigger and an error text", () => {
  test("the text is anywhere in the error. Case and line breaks do not count", () => {
    const text = (parseTrigger("err: Address already  in use") as { words: string[] }).words[0]!;
    expect(matchesError(text, "Exit code 1\nerror: listen EADDRINUSE: address already in use :::4100")).toBe(true);
    expect(matchesError(text, "Error: ADDRESS ALREADY\n   IN USE")).toBe(true);
    expect(matchesError(text, "Exit code 1\naddress in use")).toBe(false);
    expect(matchesError(text, "")).toBe(false);
  });
});

describe("a trigger as a writer gives it", () => {
  test("is stored with single spaces and its kind in lower case, each once", () => {
    expect(requireTriggers(["cmd:  pkill   -f", "CMD: pkill -f", " stop:git push --force", "err:  Address already\n in use"])).toEqual(["cmd: pkill -f", "stop: git push --force", "err: Address already in use"]);
    expect(requireTriggers([])).toEqual([]);
  });

  test("a trigger that would load in every session, or in none, is refused with the reason", () => {
    const refused = (value: unknown) => {
      try {
        requireTriggers(value);
      } catch (error) {
        expect(error).toBeInstanceOf(KbError);
        return (error as Error).message;
      }
      return "accepted";
    };
    // One word that is a common command needs a second word.
    for (const word of ["ls", "git", "cd", "cat", "echo", "bun", "rm", "npm", "sudo"]) expect(refused([`cmd: ${word}`])).toContain("matches too many commands. Add a second word");
    expect(refused(["stop: git"])).toContain("Add a second word");
    expect(refused(["cmd: git push"])).toBe("accepted");
    expect(refused(["cmd: pkill"])).toBe("accepted");
    expect(refused(["err: short"])).toContain("at least 8 characters");
    expect(refused(["err: 8 chars!"])).toBe("accepted");
    expect(refused(["run: x"])).toContain("must start with cmd:, stop:, err:");
    expect(refused(["pkill -f"])).toContain("must start with cmd:, stop:, err:");
    expect(refused(["cmd:"])).toContain("needs a text after it");
    expect(refused(["cmd: a | b"])).toContain("plain words only");
    expect(refused(["cmd: echo 'a'"])).toContain("plain words only");
    expect(refused(["cmd: FOO=1 zorp"])).toContain("must start with the command");
    expect(refused([`err: ${"x".repeat(300)}`])).toContain("over 200 characters");
    expect(refused([7])).toContain("a trigger is a text");
    expect(refused("cmd: pkill -f")).toContain("must be a list");
    expect(refused(Array.from({ length: 13 }, (_, i) => `cmd: zorp ${i}`))).toContain("at most 12");
    // Every wrong trigger is named in one answer.
    expect(refused(["cmd: git", "err: short"])).toMatch(/too many commands.*; .*at least 8/);
  });

  test("a stored trigger that this kb cannot read loads nothing and breaks nothing", () => {
    expect(readTriggers(["cmd: pkill -f", "prompt: deploy", "cmd: ls", "err: x"]).map((t) => t.text)).toEqual(["cmd: pkill -f"]);
    expect(readTriggers(undefined)).toEqual([]);
  });
});
