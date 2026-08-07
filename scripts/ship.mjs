#!/usr/bin/env node
// Day-to-day "get my work onto GitHub" helper: stage -> commit -> push,
// creating the upstream branch on first push. Deliberately refuses to run on
// a detached HEAD, where a push would go nowhere useful.
import { execFileSync } from 'node:child_process'

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim()

const run = args => execFileSync('git', args, { stdio: 'inherit' })

const message = process.argv.slice(2).join(' ').trim()
if (!message) {
  console.error('usage: npm run ship -- "<type>: <description>"')
  console.error('  types: feat, fix, refactor, docs, test, chore, perf, ci')
  process.exit(1)
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch === 'HEAD') {
  console.error('detached HEAD - check out a branch before shipping')
  process.exit(1)
}

const dirty = git(['status', '--porcelain'])
if (dirty) {
  run(['add', '-A'])
  run(['commit', '-m', message])
} else {
  console.log('nothing to commit - pushing existing commits')
}

// --set-upstream is harmless when the branch is already tracked, but only
// pass it when it is actually needed so the output stays quiet.
let tracked = true
try {
  git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
} catch {
  tracked = false
}

run(tracked ? ['push'] : ['push', '--set-upstream', 'origin', branch])
console.log(`\npushed ${branch} -> origin`)
