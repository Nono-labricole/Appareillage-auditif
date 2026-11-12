"""Logiciel pour mettre des mots-clés sur vos photos.

    python etiqueter.py mes_photos

Ouvre une page dans votre navigateur (elle tourne uniquement sur votre ordinateur, rien
n'est envoyé sur Internet). Pour chaque photo :
  - tapez des mots-clés (Entrée ou virgule pour valider), ou cliquez sur ceux déjà utilisés ;
  - facultatif : tracez à la souris la « zone importante » (ce qui ne doit jamais être coupé
    par les recadrages automatiques) ;
  - tout est enregistré automatiquement dans mes_photos/etiquettes.json.

Raccourcis : Alt+→ / Alt+← (ou Page suivante/précédente) pour changer de photo,
Alt+C pour copier les mots-clés de la photo précédente.
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

PAGE = r"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Étiqueter mes photos</title>
<style>
:root{--bg:#f6f6f4;--panel:#fff;--txt:#1d1d1f;--mut:#6b6b70;--bord:#dcdcd8;--acc:#2f6fdf;--accbg:#e7effd;--zone:#ff9f1c}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--panel:#202024;--txt:#ececef;--mut:#9a9aa2;--bord:#35353b;--acc:#7aa7ff;--accbg:#22314f}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--txt);height:100vh;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bord);background:var(--panel);flex-wrap:wrap}
header b{font-size:16px}#prog{color:var(--mut)}#barre{flex:1;min-width:120px;height:6px;background:var(--bord);border-radius:3px;overflow:hidden}#barre>div{height:100%;background:var(--acc)}
main{flex:1;display:flex;min-height:0}
#gauche{flex:1;display:flex;align-items:center;justify-content:center;padding:12px;min-width:0;position:relative}
#cadre{position:relative;max-width:100%;max-height:100%;line-height:0;user-select:none;cursor:crosshair}
#img{display:block}
#zone{position:absolute;border:2px dashed var(--zone);background:rgba(255,159,28,.12);display:none;pointer-events:none}
#droite{width:360px;max-width:45vw;border-left:1px solid var(--bord);background:var(--panel);padding:14px;overflow:auto;display:flex;flex-direction:column;gap:12px}
h3{margin:4px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
#nom{font-weight:600;word-break:break-all}
input[type=text]{width:100%;padding:9px 10px;border:1px solid var(--bord);border-radius:8px;background:var(--bg);color:var(--txt);font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--bord);border-radius:999px;padding:4px 10px;cursor:pointer;background:var(--bg);color:var(--txt);font-size:14px}
.chip.on{background:var(--accbg);border-color:var(--acc);color:var(--acc)}
.chip small{color:var(--mut);margin-left:4px}
.btns{display:flex;gap:8px;flex-wrap:wrap}
button{padding:8px 12px;border-radius:8px;border:1px solid var(--bord);background:var(--bg);color:var(--txt);cursor:pointer;font-size:14px}
button.p{background:var(--acc);color:#fff;border-color:var(--acc)}
.mut{color:var(--mut);font-size:13px}#etat{font-size:13px;color:var(--mut);min-height:1em}
label{font-size:14px;display:flex;gap:6px;align-items:center}
@media (max-width:760px){main{flex-direction:column}#gauche{height:55vh;flex:none}#droite{width:auto;max-width:none;border-left:0;border-top:1px solid var(--bord)}}
</style></head><body>
<header><b>Étiqueter mes photos</b><span id="prog"></span><div id="barre"><div></div></div>
<label><input type="checkbox" id="filtre"> seulement les photos sans mot-clé</label></header>
<main><div id="gauche"><div id="cadre"><img id="img" draggable="false"><div id="zone"></div></div></div>
<div id="droite">
 <div><div id="nom"></div><div class="mut" id="pos"></div></div>
 <div class="btns"><button id="prec">← Précédente</button><button id="suiv" class="p">Suivante →</button></div>
 <h3>Mots-clés de cette photo</h3>
 <input type="text" id="saisie" placeholder="ex : short, lunettes, plan large… puis Entrée" autocomplete="off">
 <div class="chips" id="actuels"></div>
 <div class="btns"><button id="copier">Copier ceux de la photo précédente</button></div>
 <h3>Zone importante</h3>
 <div class="mut">Tracez un rectangle sur la photo autour de ce qui ne doit jamais être coupé (vous en entier, l'objet important…). Facultatif.</div>
 <div class="btns"><button id="effzone">Effacer la zone</button></div>
 <h3>Mots-clés déjà utilisés</h3>
 <div class="chips" id="tous"></div>
 <div id="etat"></div>
 <div class="mut">Règles miroir / recadrage : fichier <code>regles.json</code> dans le dossier des photos.</div>
</div></main>
<script>
let S={images:[],etiq:{}},i=0,liste=[];
const $=id=>document.getElementById(id);
const norm=t=>t.trim().toLowerCase().replace(/[\s_]+/g,' ');
async function charger(){S=await (await fetch('/api/etat')).json();filtrer(true);}
function filtrer(debut){const cur=liste[i];liste=$('filtre').checked?S.images.filter(f=>!(S.etiq[f]&&S.etiq[f].tags.length)||f===cur):S.images.slice();
 i=Math.max(0,liste.indexOf(cur));if(debut){const k=liste.findIndex(f=>!(S.etiq[f]&&S.etiq[f].tags.length));if(k>=0)i=k;}afficher();}
function entree(f){return S.etiq[f]||(S.etiq[f]={tags:[]});}
function compte(){const c={};for(const f of S.images)for(const t of (S.etiq[f]?.tags||[]))c[t]=(c[t]||0)+1;return c;}
function afficher(){
 const f=liste[i];const fait=S.images.filter(x=>S.etiq[x]&&S.etiq[x].tags.length).length;
 $('prog').textContent=`${fait} / ${S.images.length} photos étiquetées`;$('barre').firstChild.style.width=(100*fait/Math.max(1,S.images.length))+'%';
 if(!f){$('nom').textContent='Aucune photo';$('img').removeAttribute('src');$('actuels').innerHTML='';majTous();return;}
 $('nom').textContent=f;$('pos').textContent=`Photo ${i+1} sur ${liste.length}`;
 $('img').src='/img?f='+encodeURIComponent(f);majActuels();majTous();
}
function majActuels(){const e=entree(liste[i]);$('actuels').innerHTML='';
 for(const t of e.tags){const c=document.createElement('span');c.className='chip on';c.textContent=t+' ✕';c.title='Retirer';c.onclick=()=>{basculer(t)};$('actuels').append(c);}
 if(!e.tags.length)$('actuels').innerHTML='<span class="mut">Aucun mot-clé pour l\'instant</span>';dessinerZone();}
function majTous(){const c=compte(),e=liste[i]?entree(liste[i]):{tags:[]};$('tous').innerHTML='';
 const q=norm($('saisie').value);
 for(const [t,n] of Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))){if(q&&!t.includes(q))continue;
  const s=document.createElement('span');s.className='chip'+(e.tags.includes(t)?' on':'');s.innerHTML='';s.textContent=t;const sm=document.createElement('small');sm.textContent=n;s.append(sm);s.onclick=()=>basculer(t);$('tous').append(s);}
 if(!$('tous').children.length)$('tous').innerHTML='<span class="mut">—</span>';}
function basculer(t){const e=entree(liste[i]);t=norm(t);if(!t)return;e.tags=e.tags.includes(t)?e.tags.filter(x=>x!==t):[...e.tags,t].sort();majActuels();majTous();sauver();}
let timer;function sauver(){const f=liste[i],e=entree(f);clearTimeout(timer);$('etat').textContent='Enregistrement…';
 timer=setTimeout(async()=>{const r=await fetch('/api/sauver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fichier:f,tags:e.tags,zone:e.zone||null})});
 $('etat').textContent=r.ok?'Enregistré ✓':'Erreur d\'enregistrement !';const fait=S.images.filter(x=>S.etiq[x]&&S.etiq[x].tags.length).length;$('prog').textContent=`${fait} / ${S.images.length} photos étiquetées`;$('barre').firstChild.style.width=(100*fait/Math.max(1,S.images.length))+'%';},250);}
function aller(d){if(!liste.length)return;flush();i=Math.min(liste.length-1,Math.max(0,i+d));if($('filtre').checked)filtrer();else afficher();$('saisie').focus();}
function flush(){const v=$('saisie').value;if(v.trim()){for(const t of v.split(','))if(norm(t))ajouter(t);$('saisie').value='';}}
function ajouter(t){const e=entree(liste[i]);t=norm(t);if(t&&!e.tags.includes(t)){e.tags=[...e.tags,t].sort();majActuels();majTous();sauver();}}
$('saisie').addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===','){ev.preventDefault();const v=$('saisie').value;if(v.trim()){for(const t of v.split(','))ajouter(t);$('saisie').value='';majTous();}else if(ev.key==='Enter')aller(1);}});
$('saisie').addEventListener('input',majTous);
$('prec').onclick=()=>aller(-1);$('suiv').onclick=()=>aller(1);
$('copier').onclick=()=>{const p=liste[i-1];if(!p)return;for(const t of (S.etiq[p]?.tags||[]))ajouter(t);};
$('filtre').onchange=()=>filtrer();
document.addEventListener('keydown',ev=>{if((ev.altKey&&ev.key==='ArrowRight')||ev.key==='PageDown'){ev.preventDefault();aller(1);}
 if((ev.altKey&&ev.key==='ArrowLeft')||ev.key==='PageUp'){ev.preventDefault();aller(-1);}
 if(ev.altKey&&(ev.key==='c'||ev.key==='C')){ev.preventDefault();$('copier').click();}});
// --- zone importante ---
let dep=null;const img=$('img');
function pos(ev){const r=img.getBoundingClientRect();return[Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height))];}
$('cadre').addEventListener('pointerdown',ev=>{if(!liste[i])return;dep=pos(ev);$('cadre').setPointerCapture(ev.pointerId);});
$('cadre').addEventListener('pointermove',ev=>{if(!dep)return;const p=pos(ev);montrer([Math.min(dep[0],p[0]),Math.min(dep[1],p[1]),Math.max(dep[0],p[0]),Math.max(dep[1],p[1])]);});
$('cadre').addEventListener('pointerup',ev=>{if(!dep)return;const p=pos(ev),z=[Math.min(dep[0],p[0]),Math.min(dep[1],p[1]),Math.max(dep[0],p[0]),Math.max(dep[1],p[1])].map(v=>Math.round(v*1000)/1000);dep=null;
 const e=entree(liste[i]);if(z[2]-z[0]>0.02&&z[3]-z[1]>0.02){e.zone=z;}dessinerZone();sauver();});
$('effzone').onclick=()=>{const e=entree(liste[i]);delete e.zone;dessinerZone();sauver();};
function montrer(z){const el=$('zone');if(!z){el.style.display='none';return;}el.style.display='block';el.style.left=z[0]*100+'%';el.style.top=z[1]*100+'%';el.style.width=(z[2]-z[0])*100+'%';el.style.height=(z[3]-z[1])*100+'%';}
function dessinerZone(){montrer(liste[i]?entree(liste[i]).zone:null);}
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
    args = ap.parse_args()

    racine = Path(args.dossier).resolve()
    if not racine.is_dir():
        raise SystemExit(f"Dossier introuvable : {racine}")
    D.charger_regles(racine, creer=True)  # crée regles.json avec les valeurs par défaut s'il n'existe pas
    verrou = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
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
                return self._send(200, json.dumps({"images": D.lister_images(racine),
                                                   "etiq": D.charger_etiquettes(racine)}, ensure_ascii=False))
            if u.path == "/img":
                rel = parse_qs(u.query).get("f", [""])[0]
                p = (racine / rel).resolve()
                if racine not in p.parents or p.suffix.lower() not in D.EXTS or not p.is_file():
                    return self._send(404, "{}")
                return self._send(200, p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self._send(404, "{}")

        def do_POST(self):
            if urlparse(self.path).path != "/api/sauver":
                return self._send(404, "{}")
            try:
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                f = data["fichier"]
                if f not in D.lister_images(racine):
                    return self._send(400, '{"erreur":"fichier inconnu"}')
                tags = sorted({D.normaliser_tag(t) for t in data.get("tags", []) if str(t).strip()})
                zone = data.get("zone")
                if zone is not None:
                    zone = [min(1.0, max(0.0, float(v))) for v in zone][:4]
                with verrou:
                    etiq = D.charger_etiquettes(racine)
                    e = {"tags": tags}
                    if zone and len(zone) == 4:
                        e["zone"] = zone
                    etiq[f] = e
                    D.sauver_json(racine / D.FICHIER_ETIQUETTES, etiq)
                self._send(200, '{"ok":true}')
            except (ValueError, KeyError, TypeError) as err:
                self._send(400, json.dumps({"erreur": str(err)}))

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
