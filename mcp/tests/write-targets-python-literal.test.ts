/**
 * mcp/tests/write-targets-python-literal.test.ts
 *
 * A python body writes the files its write calls name. A string that only mentions
 * a file is not written; a computed path keeps the conservative reading; and a write
 * hidden behind a read, or a script written and then run, is still seen.
 */
import { describe, it, expect } from "vitest";
import { resolveWriteTargets } from "../../hooks/lib/write-targets.mjs";

const targets = (command: string) =>
  resolveWriteTargets({ tool: "Bash", toolInput: { command }, cwd: "/proj" }).targets as string[];

describe("python write targets", () => {
  it("takes only the literal files a body writes, not strings that mention files", () => {
    const t = targets(
      "cd /tmp/s\npython3 - <<'EOF'\nimport json\nd={'note':'edited model/backbone.py','control':1}\n" +
        "json.dump(d,open('tick-after.json','w'))\nEOF",
    );
    expect(t).toEqual(["/tmp/s/tick-after.json"]);
  });

  it("sees a write that follows a read", () => {
    const t = targets("python3 - <<'EOF'\nx=open('/w/n/a.json').read()\nopen('/w/n/evaluate.py','w').write(x)\nEOF");
    expect(t).toContain("/w/n/evaluate.py");
  });

  it("keeps a literal candidate-code write in a worktree", () => {
    expect(targets("cd /w/n\npython3 - <<'EOF'\nopen('evaluate.py','w').write('x')\nEOF")).toContain("/w/n/evaluate.py");
  });

  it("reads conservatively when the written path is computed", () => {
    expect(targets("cd /w/n\npython3 - <<'EOF'\np='evaluate.py'\nopen(p,'w').write('x')\nEOF")).toContain("/w/n/evaluate.py");
  });

  it("counts a script written with cat and then run as written", () => {
    expect(targets("cd /w/n\ncat > x.py <<'EOF'\nprint(1)\nEOF\npython3 x.py")).toContain("/w/n/x.py");
  });

  it("still treats a script that is only run as read", () => {
    expect(targets("python3 /w/n/eval.py > /w/n/out.json")).toEqual(["/w/n/out.json"]);
  });

  it("does not treat a read-only analysis script that takes a path argument as a write", () => {
    const t = targets(
      "python3 - /proj/.evor/runs/m/r/nodes <<'EOF'\nimport json, sys, os\nbase = sys.argv[1]\n" +
        "for n in os.listdir(base):\n    print(json.load(open(os.path.join(base, n, 'results.json')))['fitness_value'])\nEOF",
    );
    expect(t).toEqual([]);
  });

  it("resolves a name bound once to a literal, and f-string fields drawn from a separator-free loop", () => {
    const t = targets(
      "python3 - <<'E'\nimport json,os\nsd=\"/tmp/s\"\nos.makedirs(sd,exist_ok=True)\n" +
        "base=\"/proj/.evor/runs/m/r/nodes/\"\nrows=[(\"a-01\",1,\"x y\"),(\"b-01\",2,\"z\")]\n" +
        "for n,k,c in rows:\n    p={\"result_path\":base+n+\"/results.json\"}\n    json.dump(p,open(f\"{sd}/{n}.json\",\"w\"))\nE",
    );
    expect(t).toEqual(["/tmp/s", "/tmp/s/_.json"]);
  });

  it("stays conservative when a bound name or loop value could leave the directory", () => {
    const run = "/proj/.evor/runs/m/r/nodes";
    const cases = [
      // rebound name
      `sd="/tmp/s"\nsd="${run}"\nopen(f"{sd}/a.json","w")`,
      // loop value with a separator
      `sd="/tmp/s"\nrows=[("../../${run}/x",)]\nfor (n,) in rows:\n    open(f"{sd}/{n}","w")`,
      // loop value `..`
      `sd="/tmp/s"\nrows=[("..",)]\nfor (n,) in rows:\n    open(f"{sd}/{n}","w")`,
      // loop iterable that is not a pure literal
      `sd="/tmp/s"\nrows=[(x,)]\nfor (n,) in rows:\n    open(f"{sd}/{n}","w")`,
      // loop field in a directory position
      `rows=[("a",)]\nfor (n,) in rows:\n    open(f"/tmp/{n}/${run}.json","w")`,
      // name shadowed by a parameter
      `sd="/tmp/s"\ndef w(sd):\n    open(f"{sd}/a.json","w")\nw("${run}")`,
    ];
    for (const body of cases) {
      const t = targets(`python3 - <<'E'\nimport os\nr="${run}/a.json"\n${body}\nE`);
      expect(t, body).toContain(`${run}/a.json`);
    }
  });
});
