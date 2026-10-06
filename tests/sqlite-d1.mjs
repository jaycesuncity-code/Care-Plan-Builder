// Execute real migration/guard/audit SQL rather than imitating SQL in a test fake.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export class SqliteD1 {
  constructor({ through = 9 } = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql') && Number(name.slice(0,4)) <= through).sort()) {
      this.sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    }
    this.raceOnNextWriteBatch = false;
    this.failWrites = false;
  }
  get version() { return this.sqlite.prepare('SELECT version FROM pricing_meta WHERE id=1').get().version; }
  set version(value) { this.sqlite.prepare('UPDATE pricing_meta SET version=? WHERE id=1').run(value); }
  get items() { return this.sqlite.prepare('SELECT * FROM pricing_items ORDER BY id').all(); }
  get audit() { return this.sqlite.prepare('SELECT * FROM pricing_audit ORDER BY id').all(); }
  prepare(sql) {
    const db = this;
    function statement(args=[]) {
      return { sql, args, bind(...values) { return statement(values); },
        async first() { return db.sqlite.prepare(sql).get(...args) || null; },
        async run() { return db.execute(sql,args); } };
    }
    return statement();
  }
  execute(sql,args) {
    const statement=this.sqlite.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { success:true, results:statement.all(...args).map(row=>({...row})) };
    const result=statement.run(...args);
    return { success:true, results:[], meta:{ changes:result.changes, last_row_id:result.lastInsertRowid } };
  }
  async batch(statements) {
    const writing=statements.some(s=>!/^\s*SELECT/i.test(s.sql));
    if (writing && this.failWrites) throw new Error('simulated D1 write failure');
    if (writing && this.raceOnNextWriteBatch) { this.version++; this.raceOnNextWriteBatch=false; }
    this.sqlite.exec('BEGIN');
    try {
      const results=statements.map(s=>this.execute(s.sql,s.args || []));
      this.sqlite.exec('COMMIT');return results;
    } catch(error) { this.sqlite.exec('ROLLBACK');throw error; }
  }
  close() { this.sqlite.close(); }
}
