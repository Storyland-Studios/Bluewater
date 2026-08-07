/* Distance to the nearest point of each metro's Census 2020 Urban Area,
   measured along the real driving route rather than as the crow flies:
   walk the OSRM geometry out from the site and stop where it first enters
   the polygon. Public domain, TIGERweb. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const B = JSON.parse(readFileSync('geo/bundle.json','utf8'));
const U = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Urban/MapServer/0/query';

const UA = {
  Nashville:  'Nashville-Davidson',
  Chattanooga:'Chattanooga',
  Knoxville:  'Knoxville',
  Huntsville: 'Huntsville',
  Birmingham: 'Birmingham',
  Atlanta:    'Atlanta',
  Louisville: 'Louisville',
  Memphis:    'Memphis'
  /* Dollywood is a gate, not a market — it keeps its own distance. */
};

const R=3958.8, rad=d=>d*Math.PI/180;
const hav=(a,b)=>{const dLat=rad(b[1]-a[1]),dLon=rad(b[0]-a[0]);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));};

function inside(pt, geom){
  const polys = geom.type==='Polygon' ? [geom.coordinates] : geom.coordinates;
  let win=false;
  for(const poly of polys){
    let c=false;
    for(const ring of poly){
      for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
        if(((yi>pt[1])!==(yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi)) c=!c;
      }
    }
    if(c) win=!win;
  }
  return win;
}

const out = {};
for(const r of B.routes){
  const base = UA[r.name];
  if(!base){ out[r.name] = { miles: r.miles, basis: 'gate' }; continue; }
  const file = `ua-${r.name}.json`;
  if(!existsSync(file)){
    const q = `${U}?where=${encodeURIComponent("BASENAME LIKE '"+base+"%'")}`
            + `&outFields=NAME,POP100&returnGeometry=true&outSR=4326&f=geojson`;
    const res = await fetch(q);
    writeFileSync(file, await res.text());
    await new Promise(s=>setTimeout(s,400));
  }
  const g = JSON.parse(readFileSync(file,'utf8'));
  const feats = (g.features||[]).filter(f=>f.geometry);
  if(!feats.length){ console.log(`  ${r.name}: no polygon`); continue; }
  /* several places share a name — take the most populous */
  feats.sort((a,b)=>(b.properties.POP100||0)-(a.properties.POP100||0));
  const f = feats[0];

  let total=0; for(let i=1;i<r.coords.length;i++) total+=hav(r.coords[i-1],r.coords[i]);
  const scale = r.miles/total;
  let run=0, hit=null;
  for(let i=1;i<r.coords.length;i++){
    run+=hav(r.coords[i-1],r.coords[i]);
    if(inside(r.coords[i], f.geometry)){ hit=run*scale; break; }
  }
  out[r.name] = { miles: hit===null ? r.miles : +hit.toFixed(1),
                  centre: r.miles, ua: f.properties.NAME,
                  basis: hit===null ? 'no crossing' : 'edge' };
}
writeFileSync('edge-miles.json', JSON.stringify(out,null,1));
console.log('name          centre   edge   saved   urban area');
for(const [k,v] of Object.entries(out))
  console.log('  '+k.padEnd(12)+String(v.centre??v.miles).padStart(6)+
    String(v.miles).padStart(7)+
    String(v.centre? (v.centre-v.miles).toFixed(1):'—').padStart(8)+
    '   '+(v.ua||v.basis));
