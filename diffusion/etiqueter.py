"""Logiciel pour vérifier et compléter les mots-clés de vos photos.

    python etiqueter.py mes_photos

Au démarrage, les nouvelles photos du dossier sont analysées automatiquement
(voir pre_etiqueter.py) et reçoivent une base de mots-clés, marqués « auto ».
Une page s'ouvre ensuite dans votre navigateur (elle tourne uniquement sur votre
ordinateur, rien n'est envoyé sur Internet). Pour chaque photo :
  - cochez / décochez les mots-clés, rangés par catégorie (expression, habits, météo…) ;
  - ajoutez-en de nouveaux : ils deviennent cochables pour toutes les autres photos ;
  - tracez si besoin la « zone importante » (ce qui ne doit jamais être coupé) ;
  - « Valider » confirme la photo. Les propositions des photos suivantes s'améliorent
    grâce aux photos validées (bouton « Proposer à nouveau »).

Tout est enregistré automatiquement dans etiquettes.json et vocabulaire.json.
Raccourcis : Entrée (champ vide) = valider et passer à la suivante,
Alt+← / Alt+→ = photo précédente / suivante, Alt+C = copier les mots-clés de la précédente.
"""
import argparse
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import donnees as D
import pre_etiqueter as P

PAGE = r"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Étiqueter mes photos</title>
<style>
:root{--bg:#f6f6f4;--panel:#fff;--txt:#1d1d1f;--mut:#6b6b70;--bord:#dcdcd8;--acc:#2f6fdf;--accbg:#e7effd;--auto:#b26b00;--autobg:#fff4e0;--ok:#1f8a4c;--zone:#ff9f1c}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--panel:#202024;--txt:#ececef;--mut:#9a9aa2;--bord:#35353b;--acc:#7aa7ff;--accbg:#22314f;--auto:#f0b45a;--autobg:#3a2c12;--ok:#5fd08f}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--txt);height:100vh;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bord);background:var(--panel);flex-wrap:wrap}
header b{font-size:16px}#prog{color:var(--mut)}#barre{flex:1;min-width:100px;height:6px;background:var(--bord);border-radius:3px;overflow:hidden}#barre>div{height:100%;background:var(--ok)}
select,input[type=text]{padding:8px 10px;border:1px solid var(--bord);border-radius:8px;background:var(--bg);color:var(--txt);font-size:14px}
main{flex:1;display:flex;min-height:0}
#gauche{flex:1;display:flex;align-items:center;justify-content:center;padding:12px;min-width:0}
#cadre{position:relative;line-height:0;user-select:none;cursor:crosshair}
#img{display:block}
#zone{position:absolute;border:2px dashed var(--zone);background:rgba(255,159,28,.12);display:none;pointer-events:none}
#zone.auto{border-style:dotted}
#droite{width:430px;max-width:50vw;border-left:1px solid var(--bord);background:var(--panel);padding:14px;overflow:auto;display:flex;flex-direction:column;gap:10px}
h3{margin:6px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
#nom{font-weight:600;word-break:break-all}
.ligne{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{border:1px solid var(--bord);border-radius:999px;padding:3px 10px;cursor:pointer;background:var(--bg);color:var(--txt);font-size:13.5px}
.chip:hover{border-color:var(--acc)}
.chip.on{background:var(--accbg);border-color:var(--acc);color:var(--acc)}
.chip.auto{background:var(--autobg);border:1px dashed var(--auto);color:var(--auto)}
.chip small{color:var(--mut);margin-left:4px;font-size:11px}
.edition .chip{border-style:dotted}
button{padding:7px 12px;border-radius:8px;border:1px solid var(--bord);background:var(--bg);color:var(--txt);cursor:pointer;font-size:14px}
button.p{background:var(--ok);color:#fff;border-color:var(--ok);font-weight:600}
button.on{background:var(--accbg);border-color:var(--acc);color:var(--acc)}
.mut{color:var(--mut);font-size:13px}
#statut{font-size:13px;font-weight:600;padding:2px 8px;border-radius:6px}
#statut.v{color:var(--ok)}#statut.a{color:var(--auto);background:var(--autobg)}
#etat{font-size:13px;color:var(--mut);min-height:1em}
details summary{cursor:pointer;color:var(--mut);font-size:13px}
@media (max-width:760px){main{flex-direction:column}#gauche{height:50vh;flex:none}#droite{width:auto;max-width:none;border-left:0;border-top:1px solid var(--bord)}}
</style></head><body>
<header><b>Étiqueter mes photos</b><span id="prog"></span><div id="barre"><div></div></div>
<select id="filtre"><option value="averif">À vérifier</option><option value="toutes">Toutes les photos</option><option value="verif">Déjà vérifiées</option></select>
<button id="analyser" title="Analyse les photos non vérifiées et propose des mots-clés, en s'aidant des photos déjà validées">Proposer à nouveau</button></header>
<main><div id="gauche"><div id="cadre"><img id="img" draggable="false"><div id="zone"></div></div></div>
<div id="droite">
 <div><div id="nom"></div><div class="ligne"><span class="mut" id="pos"></span><span id="statut"></span></div></div>
 <div class="ligne"><button id="prec">←</button><button id="valider" class="p">✓ Valider et suivante</button><button id="suiv">→</button><button id="copier" title="Alt+C">Copier la précédente</button></div>
 <div class="mut"><span class="chip on" style="cursor:default">coché</span> <span class="chip auto" style="cursor:default">proposé auto</span> — cliquez pour cocher/décocher. Les propositions deviennent définitives quand vous validez.</div>
 <div class="ligne"><input type="text" id="saisie" placeholder="Ajouter ou chercher un mot-clé…" autocomplete="off" style="flex:1;min-width:150px"><select id="cat"></select></div>
 <div id="cats"></div>
 <h3>Zone importante</h3>
 <div class="mut" id="zinfo">Tracez un rectangle sur la photo autour de ce qui ne doit jamais être coupé. Facultatif.</div>
 <div class="ligne"><button id="effzone">Effacer la zone</button></div>
 <details><summary>Modifier la liste des mots-clés</summary>
  <div class="mut" style="margin:6px 0">Activez le mode édition, puis cliquez sur un mot-clé pour le renommer (sur toutes les photos), le changer de catégorie ou le supprimer.</div>
  <button id="edition">Mode édition : désactivé</button></details>
 <div id="etat"></div>
</div></main>
<script>
let S={images:[],etiq:{},voc:{categories:[]}},liste=[],cur=null,edition=false;
const $=id=>document.getElementById(id);
const norm=t=>t.trim().toLowerCase().replace(/[\s_]+/g,' ');
const E=f=>S.etiq[f]||(S.etiq[f]={tags:[]});
async function api(chemin,corps){const r=await fetch(chemin,corps?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corps)}:{});if(!r.ok)throw new Error(await r.text());return r.json();}
async function charger(){S=await api('/api/etat');remplirCats();filtrer();}
function remplirCats(){const v=$('cat').value;$('cat').innerHTML='';for(const c of S.voc.categories){const o=document.createElement('option');o.value=o.textContent=c.nom;$('cat').append(o);}$('cat').value=v||'Autres';}
function ok(f){return !!(S.etiq[f]&&S.etiq[f].verifie);}
function filtrer(){const m=$('filtre').value;liste=S.images.filter(f=>m==='toutes'||(m==='verif')===ok(f));
 if(!liste.includes(cur))cur=liste[0]||null;afficher();}
function idx(){return liste.indexOf(cur);}
function progres(){const n=S.images.filter(ok).length;$('prog').textContent=`${n} / ${S.images.length} photos vérifiées`;$('barre').firstChild.style.width=(100*n/Math.max(1,S.images.length))+'%';}
function compte(){const c={};for(const f of S.images)for(const t of (S.etiq[f]?.tags||[]))c[t]=(c[t]||0)+1;return c;}
function afficher(){progres();
 if(!cur){$('nom').textContent=$('filtre').value==='averif'?'Toutes les photos sont vérifiées 🎉':'Aucune photo';$('pos').textContent='';$('statut').textContent='';$('img').removeAttribute('src');$('img').style.width=$('img').style.height='0';$('cats').innerHTML='';montrer(null);return;}
 $('nom').textContent=cur;$('pos').textContent=`${idx()+1} sur ${liste.length}`;
 const e=E(cur);$('statut').textContent=e.verifie?'Vérifiée ✓':'À vérifier';$('statut').className=e.verifie?'v':'a';
 if($('img').dataset.f!==cur){$('img').dataset.f=cur;$('img').src='/img?f='+encodeURIComponent(cur);}
 majChips();dessinerZone();}
function majChips(){const e=cur?E(cur):{tags:[]},c=compte(),q=norm($('saisie').value),auto=new Set(e.auto||[]);
 const connus=new Set();$('cats').innerHTML='';$('cats').className=edition?'edition':'';
 const cats=S.voc.categories.map(k=>({nom:k.nom,tags:[...k.tags]}));
 for(const k of cats)for(const t of k.tags)connus.add(t);
 const autres=cats.find(k=>k.nom==='Autres');for(const t of Object.keys(c).concat(e.tags))if(!connus.has(t)){autres.tags.push(t);connus.add(t);}
 for(const k of cats){const tags=k.tags.filter(t=>!q||t.includes(q));if(!tags.length)continue;
  const h=document.createElement('h3');h.textContent=k.nom;$('cats').append(h);const d=document.createElement('div');d.className='chips';
  for(const t of tags){const s=document.createElement('span');const on=e.tags.includes(t);s.className='chip'+(on?(auto.has(t)&&!e.verifie?' auto':' on'):'');
   s.textContent=t;if(c[t]){const m=document.createElement('small');m.textContent=c[t];s.append(m);}
   s.title=on&&auto.has(t)?'Proposé automatiquement — cliquez pour le retirer':'';s.onclick=()=>edition?editer(t,k.nom):basculer(t);d.append(s);}
  $('cats').append(d);}
 if(q&&!connus.has(q)){const b=document.createElement('button');b.textContent=`+ Ajouter « ${q} » dans ${$('cat').value}`;b.onclick=()=>ajouterNouveau(q);$('cats').prepend(b);}}
function basculer(t){if(!cur)return;const e=E(cur);t=norm(t);if(!t)return;
 if(e.tags.includes(t)){e.tags=e.tags.filter(x=>x!==t);if((e.auto||[]).includes(t)){e.auto=e.auto.filter(x=>x!==t);(e.refuse=e.refuse||[]).push(t);}}
 else{e.tags=[...e.tags,t].sort();e.refuse=(e.refuse||[]).filter(x=>x!==t);}
 majChips();sauver(cur);}
async function ajouterNouveau(t){t=norm(t);if(!t)return;const cat=$('cat').value;
 S.voc=(await api('/api/vocab/ajouter',{tag:t,categorie:cat})).voc;$('saisie').value='';if(cur&&!E(cur).tags.includes(t))basculer(t);else majChips();}
async function editer(t,cat){const n=prompt(`Renommer « ${t} » (sur toutes les photos).\nLaissez vide pour le supprimer de la liste.`,t);if(n===null)return;
 if(!norm(n)){const partout=confirm(`Retirer aussi « ${t} » de toutes les photos ?\n(OK = oui, Annuler = seulement de la liste)`);await api('/api/supprimer',{tag:t,partout});}
 else{const nc=prompt('Catégorie :\n'+S.voc.categories.map(k=>k.nom).join(', '),cat);await api('/api/renommer',{ancien:t,nouveau:n,categorie:nc||cat});}
 await charger();}
const minuteurs={};function sauver(f){const e=E(f);clearTimeout(minuteurs[f]);$('etat').textContent='Enregistrement…';
 minuteurs[f]=setTimeout(async()=>{try{await api('/api/sauver',{fichier:f,tags:e.tags,auto:e.auto||[],refuse:e.refuse||[],zone:e.zone||null,zone_auto:!!e.zone_auto,verifie:!!e.verifie});$('etat').textContent='Enregistré ✓';}catch(err){$('etat').textContent='Erreur d\'enregistrement : '+err.message;}progres();},200);}
function aller(d){if(!liste.length)return;flush();const i=Math.min(liste.length-1,Math.max(0,idx()+d));cur=liste[i];afficher();$('saisie').focus();}
function flush(){const v=$('saisie').value;if(v.includes(',')){for(const t of v.split(','))if(norm(t))ajouterNouveau(t);}}
function valider(){if(!cur)return;flush();const e=E(cur);e.verifie=true;e.auto=[];sauver(cur);
 const i=idx();if($('filtre').value==='averif'){liste.splice(i,1);cur=liste[Math.min(i,liste.length-1)]||null;}else cur=liste[Math.min(i+1,liste.length-1)];afficher();$('saisie').focus();}
$('saisie').addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===','){ev.preventDefault();const v=norm($('saisie').value);
  if(v){const exact=S.voc.categories.some(k=>k.tags.includes(v))||Object.keys(compte()).includes(v);if(exact){basculer(v);$('saisie').value='';majChips();}else ajouterNouveau(v);}
  else if(ev.key==='Enter')valider();}});
$('saisie').addEventListener('input',majChips);$('cat').onchange=majChips;
$('prec').onclick=()=>aller(-1);$('suiv').onclick=()=>aller(1);$('valider').onclick=valider;
$('copier').onclick=()=>{const p=liste[idx()-1];if(!p||!cur)return;const e=E(cur);for(const t of (S.etiq[p]?.tags||[]))if(!e.tags.includes(t))e.tags.push(t);e.tags.sort();majChips();sauver(cur);};
$('filtre').onchange=filtrer;
$('edition').onclick=()=>{edition=!edition;$('edition').textContent='Mode édition : '+(edition?'activé':'désactivé');$('edition').classList.toggle('on',edition);majChips();};
$('analyser').onclick=async()=>{$('analyser').disabled=true;$('etat').textContent='Analyse en cours…';try{const r=await api('/api/analyser',{});$('etat').textContent=`${r.modifiees} photos ont reçu de nouvelles propositions.`;await charger();}catch(err){$('etat').textContent='Erreur : '+err.message;}$('analyser').disabled=false;};
document.addEventListener('keydown',ev=>{if(ev.altKey&&ev.key==='ArrowRight'){ev.preventDefault();aller(1);}if(ev.altKey&&ev.key==='ArrowLeft'){ev.preventDefault();aller(-1);}
 if(ev.altKey&&(ev.key==='c'||ev.key==='C')){ev.preventDefault();$('copier').click();}});
// --- zone importante ---
let dep=null;const img=$('img');
function pos(ev){const r=img.getBoundingClientRect();return[Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height))];}
const rect=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
$('cadre').addEventListener('pointerdown',ev=>{if(!cur)return;dep=pos(ev);$('cadre').setPointerCapture(ev.pointerId);});
$('cadre').addEventListener('pointermove',ev=>{if(dep)montrer(rect(dep,pos(ev)),false);});
$('cadre').addEventListener('pointerup',ev=>{if(!dep)return;const z=rect(dep,pos(ev)).map(v=>Math.round(v*1000)/1000);dep=null;const e=E(cur);
 if(z[2]-z[0]>0.02&&z[3]-z[1]>0.02){e.zone=z;e.zone_auto=false;sauver(cur);}dessinerZone();});
$('effzone').onclick=()=>{if(!cur)return;const e=E(cur);delete e.zone;e.zone_auto=false;dessinerZone();sauver(cur);};
function montrer(z,auto){const el=$('zone');if(!z){el.style.display='none';return;}el.className=auto?'auto':'';el.style.display='block';el.style.left=z[0]*100+'%';el.style.top=z[1]*100+'%';el.style.width=(z[2]-z[0])*100+'%';el.style.height=(z[3]-z[1])*100+'%';}
function dessinerZone(){const e=cur?E(cur):{};montrer(e.zone||null,e.zone_auto);
 $('zinfo').textContent=e.zone?(e.zone_auto?'Zone proposée automatiquement (autour du visage). Retracez-la si besoin.':'Zone tracée par vous.'):'Tracez un rectangle sur la photo autour de ce qui ne doit jamais être coupé. Facultatif.';}
function ajuster(){const g=$('gauche'),im=$('img');if(!im.naturalWidth)return;const k=Math.min((g.clientWidth-24)/im.naturalWidth,(g.clientHeight-24)/im.naturalHeight);
 im.style.width=Math.round(im.naturalWidth*k)+'px';im.style.height=Math.round(im.naturalHeight*k)+'px';}
$('img').addEventListener('load',ajuster);window.addEventListener('resize',ajuster);
charger();$('saisie').focus();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dossier", help="dossier contenant vos photos")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--sans-navigateur", action="store_true", help="ne pas ouvrir le navigateur automatiquement")
    ap.add_argument("--sans-analyse", action="store_true", help="ne pas proposer de mots-clés automatiquement")
    ap.add_argument("--sans-visages", action="store_true", help="ne pas utiliser la détection de visages")
    args = ap.parse_args()

    racine = Path(args.dossier).resolve()
    if not racine.is_dir():
        raise SystemExit(f"Dossier introuvable : {racine}")
    D.charger_regles(racine, creer=True)  # crée regles.json et vocabulaire.json s'ils n'existent pas
    D.charger_vocabulaire(racine, creer=True)
    verrou = threading.Lock()

    def analyser(seulement_nouvelles):
        with verrou:
            etiq = D.charger_etiquettes(racine)
            voc = D.charger_vocabulaire(racine)
            if seulement_nouvelles:
                nouvelles = [f for f in D.lister_images(racine) if f not in etiq]
                if not nouvelles:
                    return 0
                print(f"Analyse de {len(nouvelles)} nouvelle(s) photo(s)…")
            n = P.proposer(racine, etiq, voc, avec_visages=not args.sans_visages)
            D.sauver_json(racine / D.FICHIER_ETIQUETTES, etiq)
            D.sauver_json(racine / D.FICHIER_VOCABULAIRE, voc)
            return n

    if not args.sans_analyse:
        n = analyser(seulement_nouvelles=True)
        if n:
            print(f"{n} photo(s) ont reçu des mots-clés proposés.")

    def renommer_partout(etiq, ancien, nouveau):
        for e in etiq.values():
            for cle in ("tags", "auto", "refuse"):
                if ancien in e.get(cle, []):
                    e[cle] = sorted((set(e[cle]) - {ancien}) | ({nouveau} if nouveau else set()))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False)
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                return self._send(200, PAGE, "text/html; charset=utf-8")
            if u.path == "/api/etat":
                with verrou:
                    return self._send(200, {"images": D.lister_images(racine), "etiq": D.charger_etiquettes(racine),
                                            "voc": D.charger_vocabulaire(racine)})
            if u.path == "/img":
                rel = parse_qs(u.query).get("f", [""])[0]
                p = (racine / rel).resolve()
                if racine not in p.parents or p.suffix.lower() not in D.EXTS or not p.is_file():
                    return self._send(404, {})
                return self._send(200, p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self._send(404, {})

        def do_POST(self):
            chemin = urlparse(self.path).path
            try:
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if chemin == "/api/analyser":
                    return self._send(200, {"modifiees": analyser(seulement_nouvelles=False)})
                with verrou:
                    etiq = D.charger_etiquettes(racine)
                    voc = D.charger_vocabulaire(racine)
                    if chemin == "/api/sauver":
                        f = data["fichier"]
                        if f not in D.lister_images(racine):
                            return self._send(400, {"erreur": "fichier inconnu"})
                        tags = sorted({D.normaliser_tag(t) for t in data.get("tags", []) if str(t).strip()})
                        e = {"tags": tags, "verifie": bool(data.get("verifie"))}
                        auto = sorted(set(map(D.normaliser_tag, data.get("auto", []))) & set(tags))
                        if auto and not e["verifie"]:
                            e["auto"] = auto
                        refuse = sorted(set(map(D.normaliser_tag, data.get("refuse", []))) - set(tags))
                        if refuse:
                            e["refuse"] = refuse
                        zone = data.get("zone")
                        if zone and len(zone) == 4:
                            e["zone"] = [min(1.0, max(0.0, float(v))) for v in zone]
                            if data.get("zone_auto"):
                                e["zone_auto"] = True
                        etiq[f] = e
                        D.sauver_json(racine / D.FICHIER_ETIQUETTES, etiq)
                        return self._send(200, {"ok": True})
                    if chemin == "/api/vocab/ajouter":
                        t = D.normaliser_tag(data["tag"])
                        if t and t not in D.categorie_de(voc):
                            cat = next((c for c in voc["categories"] if c["nom"] == data.get("categorie")),
                                       next(c for c in voc["categories"] if c["nom"] == "Autres"))
                            cat["tags"].append(t)
                            D.sauver_json(racine / D.FICHIER_VOCABULAIRE, voc)
                        return self._send(200, {"voc": voc})
                    if chemin == "/api/renommer":
                        a, n = D.normaliser_tag(data["ancien"]), D.normaliser_tag(data["nouveau"])
                        for c in voc["categories"]:
                            c["tags"] = [t for t in c["tags"] if t not in (a, n)]
                        cat = next((c for c in voc["categories"] if c["nom"] == data.get("categorie")),
                                   next(c for c in voc["categories"] if c["nom"] == "Autres"))
                        cat["tags"].append(n)
                        renommer_partout(etiq, a, n)
                    elif chemin == "/api/supprimer":
                        t = D.normaliser_tag(data["tag"])
                        for c in voc["categories"]:
                            c["tags"] = [x for x in c["tags"] if x != t]
                        if data.get("partout"):
                            renommer_partout(etiq, t, None)
                    else:
                        return self._send(404, {})
                    D.sauver_json(racine / D.FICHIER_VOCABULAIRE, voc)
                    D.sauver_json(racine / D.FICHIER_ETIQUETTES, etiq)
                    return self._send(200, {"ok": True})
            except (ValueError, KeyError, TypeError) as err:
                self._send(400, {"erreur": str(err)})

    serveur = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)  # accessible uniquement depuis cet ordinateur
    url = f"http://127.0.0.1:{args.port}/"
    print(f"{len(D.lister_images(racine))} photos dans {racine}")
    print(f"Ouvrez {url} dans votre navigateur (Ctrl+C pour arrêter).")
    if not args.sans_navigateur:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêté. Mots-clés enregistrés dans", racine / D.FICHIER_ETIQUETTES)


if __name__ == "__main__":
    main()
