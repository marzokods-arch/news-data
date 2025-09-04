import Parser from 'rss-parser';
const i = idx++; const r = await ingestFeed(workList[i]); results.push(r);
}
}
await Promise.all(Array.from({length:CONCURRENCY}, worker));


// Collect items
let items = results.flatMap(r=> r.items||[]);
// Sort & cap
items.sort((a,b)=> new Date(b.pubDate||0) - new Date(a.pubDate||0));
const MAX_LATEST = 4000; items = items.slice(0, MAX_LATEST);


// Build partitions
const byCat = {}; const byLang = {}; const byRegion = {};
for (const it of items){
(byCat[it.category] ||= []).push(it);
(byLang[it.lang] ||= []).push(it);
(byRegion[it.region] ||= []).push(it);
}


const payload = {
generated_at: new Date().toISOString(),
total: items.length,
processed_feeds: workList.length,
discovered_feeds: discovered.length,
sports_processed_every_run: true,
shard_of: SHARDS,
shard_index: shard,
results: results.map(r=>({
name: r.src.name, url: r.src.feedUrl, homepage: r.src.homepage, lang: r.src.lang, region: r.src.region, cats: r.src.categories, taken: r.taken, error: r.error||null, notModified: !!r.notModified
}))
};


await fs.writeFile(path.join(API,'latest.json'), JSON.stringify({meta:payload, items}, null, 2));
for (const [k,v] of Object.entries(byCat)) await fs.writeFile(path.join(API,'categories',`${k}.json`), JSON.stringify(v, null, 2));
for (const [k,v] of Object.entries(byLang)) await fs.writeFile(path.join(API,'lang',`${k}.json`), JSON.stringify(v, null, 2));
for (const [k,v] of Object.entries(byRegion)) await fs.writeFile(path.join(API,'regions',`${k}.json`), JSON.stringify(v, null, 2));


// Day snapshot
const dayKey = new Date().toISOString().slice(0,10); // YYYY-MM-DD
await fs.writeFile(path.join(API,'days',`${dayKey}.json`), JSON.stringify(items, null, 2));


// Save state
await fs.writeFile(statePath, JSON.stringify(feedState, null, 2));


// Index
await fs.writeFile(path.join(API,'index.json'), JSON.stringify({
latest: "/api/latest.json",
categories: Object.keys(byCat).map(c=>`/api/categories/${c}.json`),
lang: Object.keys(byLang).map(l=>`/api/lang/${l}.json`),
regions: Object.keys(byRegion).map(r=>`/api/regions/${r}.json`),
days: [`/api/days/${dayKey}.json`]
}, null, 2));


console.log(`Done. Items: ${items.length}; Feeds processed: ${workList.length}/${all.length} (sports + shard ${shard}/${SHARDS}).`);
})().catch(e=>{ console.error(e); process.exit(1); });
