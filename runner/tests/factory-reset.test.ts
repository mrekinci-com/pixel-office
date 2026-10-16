import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from '../src/worker.js';
import type { RunnerConfig } from '../src/config.js';
test("Reset stops target work/commands and waits for markers to clear before confirming quiescence", async () => {
    const root = resolve('.test-data');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'reset-'));
    const agent = randomUUID(), target = randomUUID(), other = randomUUID(), reset = randomUUID(), nonce = randomUUID(), controller = new AbortController();
    const config: RunnerConfig = { url: 'http://office.test', key: 'yalniz-test-anahtari'.repeat(3), workDir: dir, concurrency: 2, allowedRoots: [], protectedRoots: [], claude: 'claude', codex: 'codex', bwrap: 'bwrap', codexModel: 'test' };
    let resetting = true, stops = 0, otherStops = 0;
    const calls: {
        path: string;
        body: any;
    }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
        const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body));
        calls.push({ path, body });
        return Response.json(path.endsWith('/heartbeat') ? { language: 'tr', reset: resetting ? { id: reset, nonce, agents: [agent], runs: [target] } : null, profileDeletions: [agent], sessionProfiles: [], commandJobs: [], stop: [], links: [], approvals: [], paused: true } : { ok: true });
    };
    const worker = new Worker(config, fetcher, command => command);
    const commands = (worker as unknown as {
        commandActive: Map<string, {
            run: string;
            controller: AbortController;
        }>;
    }).commandActive;
    try {
        for (const profile of ['.oturum', '.terminal']) {
            mkdirSync(join(dir, profile, agent), { recursive: true });
            writeFileSync(join(dir, profile, agent, 'fixture'), 'yalniz-deneme');
        }
        const control = join(dir, '.terminal-control');
        mkdirSync(control);
        writeFileSync(join(control, `gm-${agent}-1.json`), '{}');
        writeFileSync(join(control, 'unrelated.json'), '{}');
        worker.active.set(target, { stop: () => { stops++; } });
        worker.active.set(other, { stop: () => { otherStops++; } });
        commands.set('command', { run: target, controller });
        await worker.tick();
        assert.equal(stops, 1);
        assert.equal(otherStops, 0);
        assert.equal(controller.signal.aborted, true);
        assert.ok(!calls.some(c => c.path.endsWith('/reset-idle')));
        assert.equal(existsSync(join(dir, '.oturum', agent)), true);
        worker.active.delete(target);
        await worker.tick();
        assert.ok(!calls.some(c => c.path.endsWith('/reset-idle')), "Command markers prevent quiescence confirmation.");
        commands.delete('command');
        await worker.tick();
        const ack = calls.find(c => c.path.endsWith('/reset-idle'))!;
        assert.deepEqual(ack.body, { runner: worker.id, reset, nonce });
        assert.equal(otherStops, 0);
        resetting = false;
        await worker.tick();
        assert.equal(existsSync(join(dir, '.oturum', agent)), false);
        assert.equal(existsSync(join(dir, '.terminal', agent)), false);
        assert.equal(existsSync(join(control, `gm-${agent}-1.json`)), false);
        assert.equal(existsSync(join(control, 'unrelated.json')), true);
        assert.ok(!calls.some(c => c.path.endsWith('/claim')));
    }
    finally {
        worker.active.clear();
        commands.clear();
        await worker.shutdown();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("New runners check old terminal processes when the first heartbeat reports a reset", async () => {
    const {RunnerTerminal}=await import('../src/terminal.js');
    const root=resolve('.test-data');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'reset-first-'));
    const config:RunnerConfig={url:'http://office.test',key:'yalniz-test-anahtari'.repeat(3),workDir:dir,concurrency:2,allowedRoots:[],protectedRoots:[],claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'test'};
    const original=RunnerTerminal.prototype.resetIdle;let checks=0,acknowledgements=0,idle=false;
    RunnerTerminal.prototype.resetIdle=function(){checks++;return idle;};
    const worker=new Worker(config,async(url)=>{if(String(url).endsWith('/reset-idle'))acknowledgements++;return Response.json({language:'tr',reset:{id:randomUUID(),nonce:randomUUID(),agents:[randomUUID()],runs:[]}});});
    try {
        await worker.tick();assert.equal(checks,1);assert.equal(acknowledgements,0);
        idle=true;await worker.tick();assert.equal(checks,2);assert.equal(acknowledgements,1);
    } finally {RunnerTerminal.prototype.resetIdle=original;await worker.shutdown();rmSync(dir,{recursive:true,force:true});}
});
