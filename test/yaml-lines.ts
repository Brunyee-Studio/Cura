/** Body lines of every `run: |` block, i.e. the lines indented deeper than the `run:` key. */
export function runBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: \|/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length + (lines[i]!.trimStart().startsWith('- ') ? 2 : 0);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    blocks.push(body);
  }
  return blocks;
}
