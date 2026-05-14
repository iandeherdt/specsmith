#!/usr/bin/env node
// Read one or more pipeline trace JSONL files and print a digest:
// tool-call frequency, repeat-call flailing, cycle markers, token totals.

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: trace-summarise.mjs <trace.jsonl> [more.jsonl ...]

Prints a digest of pipeline trace JSONL files.

Sections:
  - Tool-call frequency (per session)
  - Suspected flails (same tool + similar args, 5+ times in a row)
  - Cycle markers (subagent_end events)
  - Token usage per session
`);
  process.exit(args.length ? 0 : 1);
}

function parseLines(path) {
  if (!existsSync(path)) {
    console.error(`skip: ${path} does not exist`);
    return [];
  }
  const raw = readFileSync(path, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed line — could be a partially-flushed write.
    }
  }
  return events;
}

function fingerprint(event) {
  // A short canonical signature for repeat-call detection. We hash the
  // first slice of the most identifying field per tool.
  const t = event.tool || '';
  const i = event.input || {};
  if (t === 'Bash') return `Bash:${(i.command || '').slice(0, 80)}`;
  if (t === 'Read') return `Read:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Edit') return `Edit:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Write') return `Write:${(i.file_path || '').slice(0, 120)}`;
  if (t === 'Grep') return `Grep:${(i.pattern || '').slice(0, 80)}`;
  if (t === 'Glob') return `Glob:${(i.pattern || '').slice(0, 80)}`;
  // Generic — JSON of inputs, capped.
  let json;
  try { json = JSON.stringify(i); } catch { json = ''; }
  return `${t}:${json.slice(0, 120)}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function summarise(allEvents) {
  // Group events by session.
  const bySession = new Map();
  for (const e of allEvents) {
    if (!e.session) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }

  for (const [session, events] of bySession) {
    const start = events[0]?.ts || '?';
    const end = events[events.length - 1]?.ts || '?';
    console.log('');
    console.log('='.repeat(70));
    console.log(`Session ${session}   ${start} → ${end}   (${events.length} events)`);
    console.log('='.repeat(70));

    // Tool frequency: use max(pre, post) per tool — every call should fire
    // both phases, but interrupted calls miss the post and stale post events
    // can outlive their pre.
    const preFreq = new Map();
    const postFreq = new Map();
    const errors = new Map();
    for (const e of events) {
      if (e.event !== 'tool_call') continue;
      if (e.phase === 'pre') {
        preFreq.set(e.tool, (preFreq.get(e.tool) || 0) + 1);
      } else if (e.phase === 'post') {
        postFreq.set(e.tool, (postFreq.get(e.tool) || 0) + 1);
        if (e.output?.error) {
          errors.set(e.tool, (errors.get(e.tool) || 0) + 1);
        }
      }
    }
    const allTools = new Set([...preFreq.keys(), ...postFreq.keys()]);
    const freq = new Map();
    let pendingTotal = 0;
    for (const tool of allTools) {
      const p = preFreq.get(tool) || 0;
      const q = postFreq.get(tool) || 0;
      freq.set(tool, Math.max(p, q));
      if (p > q) pendingTotal += p - q;
    }

    console.log('');
    console.log('Tool calls:');
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tool, n] of sorted) {
      const errs = errors.get(tool) || 0;
      const errPart = errs ? `  (${errs} error${errs === 1 ? '' : 's'})` : '';
      console.log(`  ${pad(tool, 32)} ${pad(n, 5)}${errPart}`);
    }
    if (pendingTotal > 0) {
      console.log(`  (${pendingTotal} call(s) without a post event — interrupted or in flight)`);
    }

    // Repeat-call flailing detection: 5+ consecutive same-fingerprint calls.
    const runs = [];
    let lastFp = null;
    let runStart = -1;
    let runLen = 0;
    const preEvents = events.filter((e) => e.event === 'tool_call' && e.phase === 'pre');
    for (let i = 0; i < preEvents.length; i++) {
      const fp = fingerprint(preEvents[i]);
      if (fp === lastFp) {
        runLen++;
      } else {
        if (runLen >= 5) {
          runs.push({ fp: lastFp, count: runLen, startIdx: runStart, startTs: preEvents[runStart].ts });
        }
        lastFp = fp;
        runStart = i;
        runLen = 1;
      }
    }
    if (runLen >= 5) {
      runs.push({ fp: lastFp, count: runLen, startIdx: runStart, startTs: preEvents[runStart].ts });
    }
    if (runs.length) {
      console.log('');
      console.log('Suspected flails:');
      for (const r of runs) {
        console.log(`  ${r.count}× ${r.fp}   (starting ${r.startTs})`);
      }
    }

    // Cycle markers — subagent_end / session_end events with token usage.
    const stops = events.filter((e) => e.event === 'subagent_end' || e.event === 'session_end');
    if (stops.length) {
      console.log('');
      console.log('Stop markers:');
      for (const s of stops) {
        const u = s.usage || {};
        const inTok = u.input_tokens ?? '?';
        const outTok = u.output_tokens ?? '?';
        const cacheR = u.cache_read_input_tokens ?? 0;
        const cacheW = u.cache_creation_input_tokens ?? 0;
        const m = s.model || '?';
        console.log(
          `  ${s.event}  model=${m}  in=${inTok}  out=${outTok}  cache_r=${cacheR}  cache_w=${cacheW}  ts=${s.ts}`
        );
      }
    }

    // High-level totals across the session.
    const totals = stops.reduce(
      (acc, s) => {
        const u = s.usage || {};
        acc.in += u.input_tokens || 0;
        acc.out += u.output_tokens || 0;
        acc.cacheR += u.cache_read_input_tokens || 0;
        acc.cacheW += u.cache_creation_input_tokens || 0;
        return acc;
      },
      { in: 0, out: 0, cacheR: 0, cacheW: 0 }
    );
    console.log('');
    console.log(
      `Token totals:  in=${totals.in}  out=${totals.out}  cache_read=${totals.cacheR}  cache_write=${totals.cacheW}`
    );
  }
}

const events = [];
for (const path of args) {
  events.push(...parseLines(path));
}
events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
summarise(events);
