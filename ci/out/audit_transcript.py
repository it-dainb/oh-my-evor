import json, sys, collections, glob, os
# newest transcript for the /plugin project inside the container
cands = sorted(glob.glob("/root/.claude/projects/-plugin/*.jsonl"), key=os.path.getmtime)
tr = cands[-1]
print("transcript:", tr, os.path.getsize(tr), "bytes")
rows=[]
for line in open(tr):
    line=line.strip()
    if not line: continue
    try: rows.append(json.loads(line))
    except: pass
print("rows:", len(rows))
print("row types:", dict(collections.Counter(r.get("type","?") for r in rows)))

tools=collections.Counter(); tasks=[]; skills=[]; remember=[]; bash_evor=[]
for r in rows:
    msg=r.get("message",{})
    content=msg.get("content") if isinstance(msg,dict) else None
    if isinstance(content,list):
        for c in content:
            if not isinstance(c,dict): continue
            if c.get("type")=="tool_use":
                nm=c.get("name","?"); tools[nm]+=1
                inp=c.get("input",{})
                if nm=="Task":
                    tasks.append((inp.get("subagent_type"),(inp.get("description") or "")[:70]))
                if nm in ("Skill","skill"):
                    skills.append(inp.get("skill") or inp.get("name"))
                if nm=="Bash":
                    cmd=inp.get("command","")
                    if ".evor" in cmd or "evor" in cmd.lower():
                        bash_evor.append(cmd[:90])
            if c.get("type")=="text" and "evor-remember" in c.get("text",""):
                remember.append(c["text"][:90])
print("\n=== TOOL CALLS ===")
for k,v in tools.most_common(): print(f"  {v:4d}  {k}")
print(f"\n=== SUBAGENT (Task) SPAWNS: {len(tasks)} ===")
for st,d in tasks: print(f"  type={st!r} desc={d!r}")
print(f"\n=== SKILL INVOCATIONS: {skills}")
print(f"\n=== <evor-remember> tags: {len(remember)}")
for x in remember[:6]: print("  ",x)
print(f"\n=== evor-related Bash cmds: {len(bash_evor)} (sample) ===")
for x in bash_evor[:12]: print("  ",x)
