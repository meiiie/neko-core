import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskScope } from "../src/core/task-scope.ts";
import { journalSession, livingEnabled } from "../src/core/living-memory.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

test("scoped slash commands cannot read, write, backfill or toggle the global journal", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-scope-slash-"));
  const oldHome=process.env.HOME, oldProfile=process.env.USERPROFILE;
  process.env.HOME=home; process.env.USERPROFILE=home;
  try {
    const messages=[{role:"user",content:"PRIVATE_SYNTHETIC_MARKER"},{role:"assistant",content:"working"},
      {role:"user",content:"continue safely"},{role:"assistant",content:"unverified outcome"}];
    assert.ok(journalSession({id:"global-test",cwd:home,createdAt:"2026-11-12T00:00:00Z",updatedAt:"2026-11-12T00:01:00Z",messages},home));
    const lines:string[]=[]; let persisted=0;
    // SAFETY: each scoped branch is required to return before accessing other CommandCtx fields.
    const ctx={cfg:{resolvedHome:home,model:"test"},registry:{taskScope:createTaskScope("test-task",home)},
      agent:{messages},currentSessionId:"scoped-test",persistSession:()=>{persisted++},addLine:(_kind:string,s:string)=>lines.push(s)} as any;
    for(const cmd of ["/nho PRIVATE_SYNTHETIC_MARKER","/ngu","/ngu backfill","/ngu off","/ngu on"]){
      lines.length=0; await runSlashCommand(cmd,ctx);
      assert.match(lines.join("\n"),/unavailable in (?:a )?task scope/i,cmd);
      assert.doesNotMatch(lines.join("\n"),/PRIVATE_SYNTHETIC_MARKER/,cmd);
    }
    assert.equal(persisted,0); assert.equal(livingEnabled(home),true);
    assert.equal(existsSync(join(home,".neko-core","memory","journal","scoped-test.md")),false);
  } finally {
    if(oldHome===undefined) delete process.env.HOME; else process.env.HOME=oldHome;
    if(oldProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=oldProfile;
    rmSync(home,{recursive:true,force:true});
  }
});
