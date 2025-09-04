import fs from 'fs/promises';
import path from 'path';
import Parser from 'rss-parser';
import { fileURLToPath } from 'url';
import { fetchWithRetry } from './common.mjs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');


const parser = new Parser();
const COMMON_HEADERS = { 'user-agent': 'Mozilla/5.0 (LightNewsDB/2.0; +https://github.com/your/repo)', 'accept':'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7' };


const seeds = JSON.parse(await fs.readFile(path.join(DATA,'seeds','homepages.json'),'utf-8'));


for (const s of seeds){
try {
const res = await fetchWithRetry(s.homepage, {headers:{...COMMON_HEADERS}}, 1, 10000);
const html = await res.text();
const m = html.match(/<link[^>]+type=\"application\/(?:rss|atom)\+xml\"[^>]+href=\"([^\"]+)\"/i);
console.log(s.name, m? 'OK (discovered)':'NO RSS');
} catch (e){ console.log(s.name, 'ERR', String(e)); }
}
