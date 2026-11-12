/*
 * Claude Bridge – script hôte ExtendScript (ES3) exécuté dans Premiere Pro.
 * Chaque outil reçoit un objet "args" et renvoie une valeur sérialisable.
 * Point d'entrée : ClaudeBridge.dispatch(nomOutil, args) -> chaîne JSON.
 */
var ClaudeBridge = (function () {
  var TICKS_PER_SECOND = 254016000000;

  // ---------------------------------------------------------------- JSON (ES3)
  function quote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
        var h = code.toString(16);
        while (h.length < 4) h = '0' + h;
        out += '\\u' + h;
      } else out += c;
    }
    return out + '"';
  }

  function stringify(v, depth) {
    depth = depth || 0;
    if (depth > 40) return 'null';
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return quote(v);
    if (t === 'function') return 'null';
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(stringify(v[i], depth + 1));
      return '[' + a.join(',') + ']';
    }
    var parts = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      var val = v[k];
      if (typeof val === 'function' || val === undefined) continue;
      parts.push(quote(k) + ':' + stringify(val, depth + 1));
    }
    return '{' + parts.join(',') + '}';
  }

  // ---------------------------------------------------------------- utilitaires
  function fail(msg) { throw new Error(msg); }

  function num(v, def) {
    if (v === undefined || v === null || v === '') return def;
    var n = Number(v);
    if (isNaN(n)) fail('Nombre invalide : ' + v);
    return n;
  }

  function secToTime(s) { var t = new Time(); t.seconds = s; return t; }
  function secToTicks(s) { return String(Math.round(s * TICKS_PER_SECOND)); }
  function ticksToSec(t) { return Number(t) / TICKS_PER_SECOND; }
  function round(n) { return Math.round(n * 1000) / 1000; }

  function project() {
    if (!app.project) fail('Aucun projet ouvert.');
    return app.project;
  }

  function seqFps(seq) {
    var tb = Number(seq.timebase);
    return tb ? round(TICKS_PER_SECOND / tb) : null;
  }

  function getSeq(args) {
    var p = project();
    if (args && (args.sequenceId || args.sequenceName)) {
      for (var i = 0; i < p.sequences.numSequences; i++) {
        var s = p.sequences[i];
        if ((args.sequenceId && s.sequenceID === args.sequenceId) ||
            (args.sequenceName && s.name === args.sequenceName)) return s;
      }
      fail('Séquence introuvable : ' + (args.sequenceId || args.sequenceName));
    }
    if (!p.activeSequence) fail('Aucune séquence active. Ouvrez une séquence ou utilisez set_active_sequence.');
    return p.activeSequence;
  }

  function itemTypeName(t) {
    if (t === ProjectItemType.CLIP) return 'clip';
    if (t === ProjectItemType.BIN) return 'bin';
    if (t === ProjectItemType.ROOT) return 'root';
    if (t === ProjectItemType.FILE) return 'file';
    return String(t);
  }

  function describeItem(item) {
    var d = { name: item.name, type: itemTypeName(item.type), nodeId: item.nodeId, treePath: item.treePath };
    if (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE) {
      try { d.mediaPath = item.getMediaPath(); } catch (e) {}
      try { d.isSequence = item.isSequence(); } catch (e2) {}
    }
    if (item.type === ProjectItemType.BIN) d.childCount = item.children.numItems;
    return d;
  }

  // Trouve un élément de projet par nodeId, chemin "Chutier/Sous-chutier/nom" ou simple nom.
  function findItem(ref) {
    if (!ref) fail('Paramètre "item" manquant.');
    var root = project().rootItem;
    function walk(bin, test) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        if (test(c)) return c;
        if (c.type === ProjectItemType.BIN) { var r = walk(c, test); if (r) return r; }
      }
      return null;
    }
    var found = walk(root, function (c) { return c.nodeId === ref; });
    if (found) return found;
    if (ref.indexOf('/') >= 0) {
      var parts = ref.split('/'), cur = root;
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] === '') continue;
        var next = null;
        for (var j = 0; j < cur.children.numItems; j++) {
          if (cur.children[j].name === parts[p]) { next = cur.children[j]; break; }
        }
        if (!next) { cur = null; break; }
        cur = next;
      }
      if (cur && cur !== root) return cur;
    }
    found = walk(root, function (c) { return c.name === ref; });
    if (found) return found;
    fail('Élément de projet introuvable : ' + ref);
  }

  function findBin(path, create) {
    var cur = project().rootItem;
    if (!path) return cur;
    var parts = path.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      var next = null;
      for (var j = 0; j < cur.children.numItems; j++) {
        var c = cur.children[j];
        if (c.type === ProjectItemType.BIN && c.name === parts[i]) { next = c; break; }
      }
      if (!next) {
        if (!create) fail('Chutier introuvable : ' + path);
        next = cur.createBin(parts[i]);
      }
      cur = next;
    }
    return cur;
  }

  function getTracks(seq, type) {
    return (type === 'audio') ? seq.audioTracks : seq.videoTracks;
  }

  function getTrack(seq, type, index) {
    var tracks = getTracks(seq, type || 'video');
    var i = num(index, 0);
    if (i < 0 || i >= tracks.numTracks) fail('Piste ' + type + ' ' + i + ' inexistante (' + tracks.numTracks + ' pistes).');
    return tracks[i];
  }

  function getClip(seq, args) {
    var track = getTrack(seq, args.trackType, args.trackIndex);
    var idx = num(args.clipIndex, -1);
    if (idx < 0 || idx >= track.clips.numItems) fail('Clip ' + idx + ' inexistant sur cette piste (' + track.clips.numItems + ' clips).');
    return track.clips[idx];
  }

  function describeClip(c, idx) {
    var d = {
      index: idx, name: c.name,
      start: round(c.start.seconds), end: round(c.end.seconds),
      inPoint: round(c.inPoint.seconds), outPoint: round(c.outPoint.seconds),
      duration: round(c.duration.seconds)
    };
    try { d.selected = c.isSelected(); } catch (e) {}
    try { d.disabled = c.disabled; } catch (e2) {}
    try { if (c.projectItem) d.projectItemNodeId = c.projectItem.nodeId; } catch (e3) {}
    return d;
  }

  function describeTracks(seq, type) {
    var tracks = getTracks(seq, type), out = [];
    for (var i = 0; i < tracks.numTracks; i++) {
      var t = tracks[i], clips = [];
      for (var j = 0; j < t.clips.numItems; j++) clips.push(describeClip(t.clips[j], j));
      var d = { index: i, name: t.name, clips: clips };
      try { d.muted = t.isMuted(); } catch (e) {}
      try { d.locked = t.isLocked(); } catch (e2) {}
      out.push(d);
    }
    return out;
  }

  function timecode(seq, seconds) {
    var s = seq.getSettings();
    return secToTime(seconds).getFormatted(s.videoFrameRate, s.videoDisplayFormat);
  }

  function qeSeq() {
    app.enableQE();
    var q = qe.project.getActiveSequence();
    if (!q) fail('QE : aucune séquence active.');
    return q;
  }

  function qeTrack(type, index) {
    var q = qeSeq();
    return (type === 'audio') ? q.getAudioTrackAt(num(index, 0)) : q.getVideoTrackAt(num(index, 0));
  }

  // Les items QE incluent les vides : on saute ceux de type "Empty".
  function qeClip(type, trackIndex, clipIndex) {
    var t = qeTrack(type, trackIndex), n = -1;
    for (var i = 0; i < t.numItems; i++) {
      var it = t.getItemAt(i);
      if (!it || it.type === 'Empty') continue;
      n++;
      if (n === clipIndex) return it;
    }
    fail('QE : clip ' + clipIndex + ' introuvable.');
  }

  function setTimeProp(obj, setter, seconds) {
    var errs = [];
    var attempts = [secToTime(seconds), seconds, secToTicks(seconds)];
    for (var i = 0; i < attempts.length; i++) {
      try { obj[setter](attempts[i]); return; } catch (e) { errs.push(String(e)); }
    }
    fail('Impossible d\'appeler ' + setter + ' : ' + errs.join(' | '));
  }

  function searchFiles(folder, ext, query, results, depth, max) {
    if (depth > 8 || results.length >= max || !folder.exists) return;
    var entries = folder.getFiles();
    for (var i = 0; i < entries.length && results.length < max; i++) {
      var f = entries[i];
      if (f instanceof Folder) searchFiles(f, ext, query, results, depth + 1, max);
      else {
        var name = decodeURI(f.name).toLowerCase(), full = f.fsName.toLowerCase();
        if (name.slice(-ext.length) === ext &&
            (!query || full.indexOf(query.toLowerCase()) >= 0)) results.push(f.fsName);
      }
    }
  }

  // ---------------------------------------------------------------- outils
  var tools = {};

  tools.ping = function () {
    return { premiere: app.version, build: app.build, projectOpen: !!app.project && !!app.project.path };
  };

  tools.get_project_info = function () {
    var p = project(), seqs = [];
    for (var i = 0; i < p.sequences.numSequences; i++) seqs.push({ name: p.sequences[i].name, sequenceId: p.sequences[i].sequenceID });
    return {
      name: p.name, path: p.path, premiereVersion: app.version,
      activeSequence: p.activeSequence ? { name: p.activeSequence.name, sequenceId: p.activeSequence.sequenceID } : null,
      sequences: seqs
    };
  };

  tools.list_project_items = function (args) {
    var bin = args.binPath ? findBin(args.binPath, false) : project().rootItem;
    var recursive = args.recursive !== false, maxItems = num(args.maxItems, 500), count = 0;
    function list(b, depth) {
      var out = [];
      for (var i = 0; i < b.children.numItems && count < maxItems; i++) {
        var c = b.children[i], d = describeItem(c);
        count++;
        if (c.type === ProjectItemType.BIN && recursive && depth < 20) d.children = list(c, depth + 1);
        out.push(d);
      }
      return out;
    }
    var items = list(bin, 0);
    return { items: items, truncated: count >= maxItems };
  };

  tools.import_files = function (args) {
    var paths = args.paths;
    if (!paths || !paths.length) fail('"paths" doit être une liste de fichiers.');
    var bin = findBin(args.binPath, true);
    for (var i = 0; i < paths.length; i++) {
      if (!new File(paths[i]).exists && !new Folder(paths[i]).exists) fail('Fichier introuvable : ' + paths[i]);
    }
    var ok = project().importFiles(paths, true, bin, !!args.asNumberedStills);
    return { imported: ok !== false, bin: bin.treePath };
  };

  tools.create_bin = function (args) {
    if (!args.name) fail('"name" requis.');
    var parent = findBin(args.parentPath, true);
    return describeItem(parent.createBin(args.name));
  };

  tools.rename_item = function (args) {
    var item = findItem(args.item);
    item.name = args.newName;
    return describeItem(item);
  };

  tools.list_sequences = function () {
    var p = project(), out = [];
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      out.push({ name: s.name, sequenceId: s.sequenceID, durationSeconds: round(ticksToSec(s.end)), fps: seqFps(s),
                 width: s.frameSizeHorizontal, height: s.frameSizeVertical,
                 active: !!p.activeSequence && p.activeSequence.sequenceID === s.sequenceID });
    }
    return out;
  };

  tools.set_active_sequence = function (args) {
    var s = getSeq(args);
    project().openSequence(s.sequenceID);
    return { name: s.name, sequenceId: s.sequenceID };
  };

  tools.create_sequence = function (args) {
    var p = project(), name = args.name || 'Séquence Claude';
    if (args.presetPath) {
      if (!new File(args.presetPath).exists) fail('Préréglage introuvable : ' + args.presetPath);
      try { p.newSequence(name, args.presetPath); }
      catch (e) { app.enableQE(); qe.project.newSequence(name, args.presetPath); }
    } else {
      p.createNewSequence(name, 'claude-' + new Date().getTime());
    }
    var s = p.activeSequence;
    return s ? { name: s.name, sequenceId: s.sequenceID } : { created: true };
  };

  tools.create_sequence_from_clips = function (args) {
    if (!args.items || !args.items.length) fail('"items" requis.');
    var clips = [];
    for (var i = 0; i < args.items.length; i++) clips.push(findItem(args.items[i]));
    var bin = args.binPath ? findBin(args.binPath, true) : project().rootItem;
    var s = project().createNewSequenceFromClips(args.name || 'Séquence Claude', clips, bin);
    return { name: s.name, sequenceId: s.sequenceID };
  };

  tools.get_sequence_info = function (args) {
    var s = getSeq(args), d = {
      name: s.name, sequenceId: s.sequenceID, fps: seqFps(s),
      width: s.frameSizeHorizontal, height: s.frameSizeVertical,
      durationSeconds: round(ticksToSec(s.end)),
      playheadSeconds: round(s.getPlayerPosition().seconds)
    };
    try { d.inPointSeconds = round(Number(s.getInPoint())); d.outPointSeconds = round(Number(s.getOutPoint())); } catch (e) {}
    if (args.includeClips !== false) {
      d.videoTracks = describeTracks(s, 'video');
      d.audioTracks = describeTracks(s, 'audio');
    }
    return d;
  };

  tools.get_selection = function (args) {
    var s = getSeq(args), sel = s.getSelection(), out = [];
    for (var i = 0; i < sel.length; i++) {
      var c = sel[i];
      out.push({ name: c.name, mediaType: c.mediaType, start: round(c.start.seconds), end: round(c.end.seconds) });
    }
    return out;
  };

  tools.set_playhead = function (args) {
    var s = getSeq(args);
    s.setPlayerPosition(secToTicks(num(args.seconds, 0)));
    return { playheadSeconds: round(s.getPlayerPosition().seconds) };
  };

  tools.set_in_out = function (args) {
    var s = getSeq(args);
    if (args.inSeconds !== undefined) setTimeProp(s, 'setInPoint', num(args.inSeconds));
    if (args.outSeconds !== undefined) setTimeProp(s, 'setOutPoint', num(args.outSeconds));
    return { inPoint: s.getInPoint(), outPoint: s.getOutPoint() };
  };

  tools.insert_clip = function (args) {
    var s = getSeq(args), item = findItem(args.item);
    var track = getTrack(s, args.trackType || 'video', args.trackIndex);
    var t = (args.seconds === undefined || args.seconds === null) ? s.getPlayerPosition() : secToTime(num(args.seconds));
    if (args.mode === 'overwrite') track.overwriteClip(item, t);
    else track.insertClip(item, t);
    return { inserted: item.name, atSeconds: round(t.seconds), mode: args.mode || 'insert' };
  };

  tools.remove_clip = function (args) {
    var s = getSeq(args), c = getClip(s, args), name = c.name;
    c.remove(!!args.ripple, true);
    return { removed: name, ripple: !!args.ripple };
  };

  tools.move_clip = function (args) {
    var s = getSeq(args), c = getClip(s, args);
    c.move(secToTime(num(args.offsetSeconds, 0)));
    return describeClip(c, num(args.clipIndex));
  };

  tools.set_clip_timing = function (args) {
    var s = getSeq(args), c = getClip(s, args);
    if (args.inPoint !== undefined) c.inPoint = secToTime(num(args.inPoint));
    if (args.outPoint !== undefined) c.outPoint = secToTime(num(args.outPoint));
    if (args.start !== undefined) c.start = secToTime(num(args.start));
    if (args.end !== undefined) c.end = secToTime(num(args.end));
    return describeClip(c, num(args.clipIndex));
  };

  tools.set_clip_enabled = function (args) {
    var s = getSeq(args), c = getClip(s, args);
    c.disabled = !args.enabled;
    return describeClip(c, num(args.clipIndex));
  };

  tools.select_clip = function (args) {
    var s = getSeq(args), c = getClip(s, args);
    c.setSelected(args.selected !== false, true);
    return describeClip(c, num(args.clipIndex));
  };

  tools.razor = function (args) {
    var s = getSeq(args), tc = timecode(s, num(args.seconds, 0)), q = qeSeq(), cut = [];
    var types = args.trackType ? [args.trackType] : ['video', 'audio'];
    for (var ti = 0; ti < types.length; ti++) {
      var n = getTracks(s, types[ti]).numTracks;
      for (var i = 0; i < n; i++) {
        if (args.trackIndices && args.trackIndices.length) {
          var wanted = false;
          for (var k = 0; k < args.trackIndices.length; k++) if (args.trackIndices[k] === i) wanted = true;
          if (!wanted) continue;
        }
        var t = types[ti] === 'audio' ? q.getAudioTrackAt(i) : q.getVideoTrackAt(i);
        t.razor(tc);
        cut.push(types[ti] + i);
      }
    }
    return { timecode: tc, tracks: cut };
  };

  tools.get_clip_effects = function (args) {
    var s = getSeq(args), c = getClip(s, args), out = [];
    for (var i = 0; i < c.components.numItems; i++) {
      var comp = c.components[i], props = [];
      for (var j = 0; j < comp.properties.numItems; j++) {
        var pr = comp.properties[j], d = { name: pr.displayName };
        try { d.value = pr.getValue(); } catch (e) {}
        try { d.timeVarying = pr.isTimeVarying(); } catch (e2) {}
        props.push(d);
      }
      out.push({ index: i, name: comp.displayName, matchName: comp.matchName, properties: props });
    }
    return out;
  };

  tools.set_clip_effect_property = function (args) {
    var s = getSeq(args), c = getClip(s, args);
    for (var i = 0; i < c.components.numItems; i++) {
      var comp = c.components[i];
      if (comp.displayName !== args.component && comp.matchName !== args.component) continue;
      for (var j = 0; j < comp.properties.numItems; j++) {
        var pr = comp.properties[j];
        if (pr.displayName !== args.property) continue;
        if (args.atSeconds !== undefined) {
          // Image clé : temps relatif au média source du clip.
          if (!pr.isTimeVarying()) pr.setTimeVarying(true);
          var kt = secToTime(c.inPoint.seconds + num(args.atSeconds));
          pr.addKey(kt);
          pr.setValueAtKey(kt, args.value, true);
        } else {
          pr.setValue(args.value, true);
        }
        var v; try { v = pr.getValue(); } catch (e) {}
        return { component: comp.displayName, property: pr.displayName, value: v };
      }
      fail('Propriété "' + args.property + '" introuvable dans "' + comp.displayName + '".');
    }
    fail('Composant/effet "' + args.component + '" introuvable sur ce clip. Utilisez get_clip_effects.');
  };

  tools.list_available_effects = function (args) {
    app.enableQE();
    var out = {};
    var kind = args.kind || 'video';
    var list;
    if (kind === 'audio') list = qe.project.getAudioEffectList();
    else if (kind === 'transition') list = qe.project.getVideoTransitionList();
    else if (kind === 'audioTransition') list = qe.project.getAudioTransitionList();
    else list = qe.project.getVideoEffectList();
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var n = String(list[i]);
      if (!args.query || n.toLowerCase().indexOf(String(args.query).toLowerCase()) >= 0) arr.push(n);
    }
    out[kind] = arr;
    return out;
  };

  tools.add_effect = function (args) {
    getSeq(args);
    var type = args.trackType || 'video', clip = qeClip(type, num(args.trackIndex, 0), num(args.clipIndex, 0));
    app.enableQE();
    if (type === 'audio') {
      var ae = qe.project.getAudioEffectByName(args.effectName);
      if (!ae) fail('Effet audio introuvable : ' + args.effectName);
      clip.addAudioEffect(ae);
    } else {
      var ve = qe.project.getVideoEffectByName(args.effectName);
      if (!ve) fail('Effet vidéo introuvable : ' + args.effectName);
      clip.addVideoEffect(ve);
    }
    return { added: args.effectName };
  };

  tools.add_transition = function (args) {
    var s = getSeq(args), type = args.trackType || 'video';
    var clip = qeClip(type, num(args.trackIndex, 0), num(args.clipIndex, 0));
    app.enableQE();
    var tr = type === 'audio' ? qe.project.getAudioTransitionByName(args.transitionName || 'Constant Power')
                              : qe.project.getVideoTransitionByName(args.transitionName || 'Cross Dissolve');
    if (!tr) fail('Transition introuvable : ' + args.transitionName);
    var dur = timecode(s, num(args.durationSeconds, 1));
    var atStart = args.position === 'start';
    if (type === 'audio') clip.addTransition(tr, atStart, dur);
    else clip.addTransition(tr, atStart, dur, '00:00:00:00', 0.5, false, true);
    return { added: args.transitionName || 'default', position: atStart ? 'start' : 'end', duration: dur };
  };

  tools.add_marker = function (args) {
    var s = getSeq(args), at = num(args.seconds, s.getPlayerPosition().seconds);
    var m = s.markers.createMarker(at);
    if (args.name) m.name = args.name;
    if (args.comment) m.comments = args.comment;
    if (args.durationSeconds) m.end = secToTime(at + num(args.durationSeconds));
    if (args.colorIndex !== undefined) { try { m.setColorByIndex(num(args.colorIndex)); } catch (e) {} }
    return { name: m.name, start: round(m.start.seconds), end: round(m.end.seconds) };
  };

  tools.list_markers = function (args) {
    var s = getSeq(args), out = [], m = s.markers.getFirstMarker();
    var guard = 0;
    while (m && guard++ < 5000) {
      out.push({ name: m.name, comment: m.comments, start: round(m.start.seconds), end: round(m.end.seconds), type: m.type });
      m = s.markers.getNextMarker(m);
    }
    return out;
  };

  tools.find_export_presets = function (args) {
    var results = [], max = num(args.max, 100);
    var roots = [new Folder(Folder.myDocuments.fsName + '/Adobe')];
    if (args.searchFolder) roots.unshift(new Folder(args.searchFolder));
    var appFolder = new Folder(app.path);
    roots.push(new Folder(appFolder.fsName + '/MediaIO/systempresets'));
    roots.push(new Folder(appFolder.fsName + '/Contents/MediaIO/systempresets'));
    roots.push(appFolder);
    for (var i = 0; i < roots.length && results.length < max; i++) searchFiles(roots[i], '.epr', args.query, results, 0, max);
    var seen = {}, uniq = [];
    for (var j = 0; j < results.length; j++) if (!seen[results[j]]) { seen[results[j]] = true; uniq.push(results[j]); }
    return uniq;
  };

  tools.export_sequence = function (args) {
    var s = getSeq(args);
    if (!args.outputPath) fail('"outputPath" requis.');
    if (!args.presetPath || !new File(args.presetPath).exists) fail('Préréglage .epr introuvable. Utilisez find_export_presets.');
    var range = args.range === 'inout' ? 1 : (args.range === 'workarea' ? 2 : 0);
    if (args.useMediaEncoder) {
      app.encoder.launchEncoder();
      var jobId = app.encoder.encodeSequence(s, args.outputPath, args.presetPath, range, 1);
      app.encoder.startBatch();
      return { queuedInMediaEncoder: true, jobId: jobId, outputPath: args.outputPath };
    }
    var r = s.exportAsMediaDirect(args.outputPath, args.presetPath, range);
    return { exported: true, result: r, outputPath: args.outputPath };
  };

  // Export audio de la séquence (pour l'analyse). soloTrackIndex : n'exporte que cette piste audio
  // (les autres sont rendues muettes le temps de l'export, puis remises dans leur état d'origine).
  tools.export_audio = function (args) {
    var s = getSeq(args);
    if (!args.outputPath || !args.presetPath) fail('"outputPath" et "presetPath" requis.');
    var range = args.range === 'inout' ? 1 : 0;
    var tracks = s.audioTracks, saved = [], r;
    var solo = (args.soloTrackIndex === undefined || args.soloTrackIndex === null) ? -1 : num(args.soloTrackIndex);
    if (solo >= tracks.numTracks) fail('Piste audio ' + solo + ' inexistante.');
    try {
      if (solo >= 0) {
        for (var i = 0; i < tracks.numTracks; i++) {
          saved.push(tracks[i].isMuted());
          tracks[i].setMute(i === solo ? 0 : 1);
        }
      }
      r = s.exportAsMediaDirect(args.outputPath, args.presetPath, range);
    } finally {
      for (var j = 0; j < saved.length; j++) { try { tracks[j].setMute(saved[j] ? 1 : 0); } catch (e) {} }
    }
    return { outputPath: args.outputPath, result: r };
  };

  tools.export_frame = function (args) {
    var s = getSeq(args);
    if (!args.outputPath) fail('"outputPath" requis.');
    var at = (args.seconds === undefined || args.seconds === null) ? s.getPlayerPosition().seconds : num(args.seconds);
    var q = qeSeq();
    var tc = timecode(s, at);
    q.exportFramePNG(tc, args.outputPath.replace(/\.png$/i, ''));
    return { timecode: tc, outputPath: args.outputPath.replace(/\.png$/i, '') + '.png' };
  };

  tools.save_project = function (args) {
    if (args && args.path) { project().saveAs(args.path); return { savedAs: args.path }; }
    project().save();
    return { saved: project().path };
  };

  tools.open_project = function (args) {
    if (!args.path || !new File(args.path).exists) fail('Projet introuvable : ' + args.path);
    app.openDocument(args.path, true, true, true);
    return { opened: args.path };
  };

  // ---- sources (rushes)
  var TEMP_BIN = '_Claude (temporaire)';

  function markersOf(collection) {
    var out = [], m, guard = 0;
    try { m = collection.getFirstMarker(); } catch (e) { return out; }
    while (m && guard++ < 2000) {
      out.push({ name: m.name, comment: m.comments, start: round(m.start.seconds), end: round(m.end.seconds), type: m.type });
      m = collection.getNextMarker(m);
    }
    return out;
  }

  tools.get_source_info = function (args) {
    var it = findItem(args.item), d = describeItem(it);
    try { d.offline = it.isOffline(); } catch (e) {}
    try { d.colorLabel = it.getColorLabel(); } catch (e) {}
    try {
      var fi = it.getFootageInterpretation();
      d.interpretation = { frameRate: fi.frameRate, pixelAspectRatio: fi.pixelAspectRatio, fieldType: fi.fieldType, alphaUsage: fi.alphaUsage };
    } catch (e) {}
    try { d.markedIn = round(it.getInPoint(4).seconds); d.markedOut = round(it.getOutPoint(4).seconds); } catch (e) {}
    try { d.projectMetadata = it.getProjectMetadata(); } catch (e) {}
    try { d.xmpMetadata = it.getXMPMetadata(); } catch (e) {}
    try { d.markers = markersOf(it.getMarkers()); } catch (e) {}

    // Où ce média est-il utilisé dans les séquences ?
    var usage = [], p = project();
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i], kinds = ['video', 'audio'];
      for (var k = 0; k < 2; k++) {
        var tracks = getTracks(s, kinds[k]);
        for (var t = 0; t < tracks.numTracks; t++) {
          for (var c = 0; c < tracks[t].clips.numItems; c++) {
            var cl = tracks[t].clips[c];
            var pi = null; try { pi = cl.projectItem; } catch (e) {}
            if (pi && pi.nodeId === it.nodeId && usage.length < 200) {
              usage.push({ sequence: s.name, sequenceId: s.sequenceID, track: (kinds[k] === 'video' ? 'V' : 'A') + (t + 1), clipIndex: c,
                           start: round(cl.start.seconds), end: round(cl.end.seconds),
                           sourceIn: round(cl.inPoint.seconds), sourceOut: round(cl.outPoint.seconds) });
            }
          }
        }
      }
    }
    d.usedIn = usage;
    return d;
  };

  // Séquence jetable contenant uniquement ce média (pour en exporter des images ou le son).
  tools.create_temp_sequence = function (args) {
    var it = findItem(args.item), p = project();
    if (it.type !== ProjectItemType.CLIP && it.type !== ProjectItemType.FILE) fail('"' + it.name + '" n\'est pas un média.');
    var prev = p.activeSequence ? p.activeSequence.sequenceID : null;
    var bin = findBin(TEMP_BIN, true);
    var s = p.createNewSequenceFromClips('_claude_apercu_' + new Date().getTime(), [it], bin);
    if (!s) fail('Impossible de créer une séquence pour ce média.');
    return { sequenceId: s.sequenceID, previousSequenceId: prev, durationSeconds: round(ticksToSec(s.end)) };
  };

  tools.delete_temp_sequence = function (args) {
    var p = project(), removed = false;
    for (var i = 0; i < p.sequences.numSequences; i++) {
      var s = p.sequences[i];
      if (s.sequenceID === args.sequenceId) { p.deleteSequence(s); removed = true; break; }
    }
    try {
      var root = p.rootItem;
      for (var j = 0; j < root.children.numItems; j++) {
        var b = root.children[j];
        if (b.type === ProjectItemType.BIN && b.name === TEMP_BIN && b.children.numItems === 0) { b.deleteBin(); break; }
      }
    } catch (e) {}
    if (args.previousSequenceId) { try { p.openSequence(args.previousSequenceId); } catch (e2) {} }
    return { removed: removed };
  };

  tools.list_media_paths = function () {
    var out = [], seen = {};
    function walk(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        if (c.type === ProjectItemType.BIN) walk(c);
        else {
          var mp = ''; try { mp = c.getMediaPath(); } catch (e) {}
          if (mp && !seen[mp]) { seen[mp] = true; out.push(mp); }
        }
      }
    }
    walk(project().rootItem);
    return { projectPath: project().path, mediaPaths: out };
  };

  // ---- primitives utilisées par les points de restauration (gérés par le serveur MCP)
  tools.checkpoint_prepare = function () {
    var p = project();
    if (!p.path) fail('Le projet doit avoir été enregistré au moins une fois.');
    p.save();
    var r = { path: p.path, name: p.name };
    if (p.activeSequence) r.activeSequenceId = p.activeSequence.sequenceID;
    return r;
  };

  tools.close_project = function () {
    if (app.project && app.project.path) app.project.closeDocument(0, 0);
    return { closed: true };
  };

  tools.reopen_project = function (args) {
    if (!new File(args.path).exists) fail('Projet introuvable : ' + args.path);
    app.openDocument(args.path, true, true, true, true);
    var seqOpened = false;
    if (args.activeSequenceId && app.project) {
      try {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          if (app.project.sequences[i].sequenceID === args.activeSequenceId) {
            app.project.openSequence(args.activeSequenceId); seqOpened = true; break;
          }
        }
      } catch (e) {}
    }
    return { reopened: args.path, sequenceOpened: seqOpened };
  };

  tools.execute_extendscript = function (args) {
    if (!args.code) fail('"code" requis.');
    /* jshint evil:true */
    var result = eval(args.code);
    if (result === undefined) return null;
    try { stringify(result); return result; } catch (e) { return String(result); }
  };

  // ---------------------------------------------------------------- dispatch
  function dispatch(name, args) {
    try {
      if (!tools.hasOwnProperty(name)) fail('Outil inconnu : ' + name);
      return stringify({ ok: true, result: tools[name](args || {}) });
    } catch (e) {
      return stringify({ ok: false, error: (e && e.message) ? e.message + (e.line ? ' (ligne ' + e.line + ')' : '') : String(e) });
    }
  }

  return { dispatch: dispatch, stringify: stringify, tools: tools };
})();
