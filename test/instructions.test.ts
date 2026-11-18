import { describe, expect, test } from "bun:test";
import { hasRule, insertRule } from "../cli/instructions.ts";

const FILE = "# Rules\n\n## Style\n\n- One.\n- Two.\n\n## Tools\n\n- Three.\n";

describe("insertRule", () => {
  test("adds the rule after the last line of its section, before the next heading", () => {
    const { content, above, added } = insertRule(FILE, "- New.", "style");
    expect(content).toBe("# Rules\n\n## Style\n\n- One.\n- Two.\n- New.\n\n## Tools\n\n- Three.\n");
    expect(above).toEqual(["", "- One.", "- Two."]);
    expect(added).toEqual(["- New."]);
  });

  test("a subsection belongs to its section, so the rule goes after it", () => {
    const file = "## Style\n\n- One.\n\n### Detail\n\n- Two.\n\n## Tools\n";
    expect(insertRule(file, "- New.", "## Style").content).toBe("## Style\n\n- One.\n\n### Detail\n\n- Two.\n- New.\n\n## Tools\n");
  });

  test("a section that does not exist is added at the end", () => {
    const { content, added } = insertRule(FILE, "- New.", "Writing");
    expect(content).toBe(`${FILE}\n## Writing\n\n- New.\n`);
    expect(added).toEqual(["", "## Writing", "", "- New."]);
  });

  test("with no section the rule goes at the end of the file, and an empty file gets only the rule", () => {
    expect(insertRule(FILE, "- New.").content).toBe(`${FILE}\n- New.\n`);
    expect(insertRule("", "- New.", "Style").content).toBe("## Style\n\n- New.\n");
  });

  test("the last section ends at the end of the file", () => {
    expect(insertRule(FILE, "- Four.\n- Five.", "Tools").content).toBe("# Rules\n\n## Style\n\n- One.\n- Two.\n\n## Tools\n\n- Three.\n- Four.\n- Five.\n");
  });

  test("a # line in a fenced code block is code, not a heading", () => {
    const file = "## Tools\n\n- a\n\n```bash\n# install it\n## Style\nbrew x\n```\n\n~~~\n# more\n~~~\n\n- b\n\n## Next\n";
    expect(insertRule(file, "- New.", "Tools").content).toBe(file.replace("- b\n", "- b\n- New.\n"));
    expect(insertRule(file, "- New.", "Style").content).toBe(`${file}\n## Style\n\n- New.\n`);
  });

  test("a heading matches by its words: formatting marks and setext headings count", () => {
    expect(insertRule("## **Style**\n\n- a\n", "- New.", "Style").content).toBe("## **Style**\n\n- a\n- New.\n");
    expect(insertRule("Style\n-----\n\n- a\n\nTools\n=====\n\n- b\n", "- New.", "Style").content).toBe("Style\n-----\n\n- a\n- New.\n\nTools\n=====\n\n- b\n");
    // A line under a list item is a thematic break, not a setext heading.
    expect(insertRule("## Style\n\n- a\n---\n- b\n", "- New.", "Style").content).toBe("## Style\n\n- a\n---\n- b\n- New.\n");
  });

  test("inline code at the start of a line, front matter and breaks do not hide or fake a heading", () => {
    expect(insertRule("```not a fence```\n\n## Style\n\n- a\n", "- New.", "Style").content).toBe("```not a fence```\n\n## Style\n\n- a\n- New.\n");
    const front = "---\nname: x\n\nStyle\n---\n\n## Style\n\n- a\n";
    expect(insertRule(front, "- New.", "Style").content).toBe(`${front}- New.\n`);
    expect(insertRule("## Style\n\n- a\n\n---\n---\n\n- b\n", "- New.", "Style").content).toBe("## Style\n\n- a\n\n---\n---\n\n- b\n- New.\n");
  });

  test("a closing run of # needs a space before it, so ## C# is the section C#", () => {
    expect(insertRule("## C#\n\n- a\n\n## Style ##\n", "- New.", "C#").content).toBe("## C#\n\n- a\n- New.\n\n## Style ##\n");
    expect(insertRule("## C#\n\n- a\n\n## Style ##\n", "- New.", "Style").content).toBe("## C#\n\n- a\n\n## Style ##\n- New.\n");
  });

  test("new lines take the line end of the line above them, and every other line keeps its own", () => {
    expect(insertRule("## Style\r\n- a\r\n\r\n## Next\r\n", "- New.", "Style").content).toBe("## Style\r\n- a\r\n- New.\r\n\r\n## Next\r\n");
    expect(insertRule("## Style\r\n- a\r\n\n## Next\n- b\n", "- New.", "Next").content).toBe("## Style\r\n- a\r\n\n## Next\n- b\n- New.\n");
  });
});

describe("hasRule", () => {
  test("finds the rule's lines one after the other, with the spaces at each end ignored", () => {
    expect(hasRule(FILE, "- One.\n- Two.")).toBe(true);
    expect(hasRule("## Style\r\n  - One.\r\n- Two.\r\n", " - One.\n- Two. ")).toBe(true);
    expect(hasRule(FILE, "- One.\n- Three.")).toBe(false);
    expect(hasRule(FILE, "- New.")).toBe(false);
  });

  test("a line in a code block is not a rule", () => {
    expect(hasRule("## Ex\n\n```\n- a\n```\n", "- a")).toBe(false);
  });
});
