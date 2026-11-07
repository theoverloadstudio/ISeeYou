'use strict';
ObjC.import('AppKit');
ObjC.import('AVFoundation');
ObjC.import('CoreMedia');
ObjC.import('QuickLookUI');
ObjC.bindFunction('CMFormatDescriptionGetExtension', ['id', ['id', 'id']]);

const TITLE = 'ISeeYou';
const RELEASES_URL = 'https://github.com/theoverloadstudio/ISeeYou/releases';
const ACCENT = () => $.NSColor.systemTealColor;
let provider, panel, pending = 0, currentReport;
let previewPanel, waveformJob, waveformView;
let statusItem;
let updateMenuItem, updateJob;
let persistent = {files:[], reports:[], active:0};
let persistentVisible = false, passiveInspector = false, panelIsPassive = false;
let hold, holdTimer;
const inspector = () => hold ? hold.inspector : persistent;
const streamDeckDirectory = () => str($.NSHomeDirectory())+'/Library/Caches/com.theoverloadstudio.iseeyou';
const HOLD_FILENAME = 'stream-deck-preview.json';
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REQUEST_TOKEN = new RegExp('^'+UUID_PATTERN+'$', 'i');
const TOGGLE_FILENAME = new RegExp('^stream-deck-toggle-('+UUID_PATTERN+')\\.json$', 'i');
const consumedToggles = new Set();
const codecs = {
  'lpcm':'Linear PCM','sowt':'Linear PCM','twos':'Linear PCM','in24':'Linear PCM',
  'aac ':'AAC','aach':'HE-AAC','aacp':'HE-AAC v2','alac':'Apple Lossless','flac':'FLAC',
  '.mp3':'MP3','mp3 ':'MP3','ac-3':'Dolby Digital','ec-3':'Dolby Digital Plus','Opus':'Opus',
  'avc1':'H.264 / AVC','avc3':'H.264 / AVC','hvc1':'HEVC / H.265','hev1':'HEVC / H.265',
  'apch':'ProRes 422 HQ','apcn':'ProRes 422','apcs':'ProRes 422 LT','apco':'ProRes 422 Proxy',
  'ap4h':'ProRes 4444','ap4x':'ProRes 4444 XQ','aprn':'ProRes RAW','aprh':'ProRes RAW HQ',
  'av01':'AV1','vp09':'VP9','jpeg':'Motion JPEG','mp4v':'MPEG-4 Video','dvcp':'DV'
};
const containers = {mov:'QuickTime Movie',mp4:'MPEG-4',m4v:'MPEG-4 Video',m4a:'MPEG-4 Audio',
  wav:'WAV',aif:'AIFF',aiff:'AIFF',aifc:'AIFF-C',mp3:'MP3',caf:'Core Audio Format',flac:'FLAC',
  mxf:'MXF',mkv:'Matroska',webm:'WebM',aac:'AAC',mpg:'MPEG',mpeg:'MPEG',avi:'AVI'};
function str(value) { try { return value.js; } catch (_) { return undefined; } }
function get(fn) { try { return fn(); } catch (_) { return undefined; } }
function fourcc(n) { return String.fromCharCode((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255); }
function fixed(n, digits) { return Number(n.toFixed(digits)).toString(); }
function duration(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const ms=Math.round(n*1000), pad=(x,k=2)=>String(x).padStart(k,'0');
  return pad(Math.floor(ms/3600000))+':'+pad(Math.floor(ms/60000)%60)+':'+pad(Math.floor(ms/1000)%60)+'.'+pad(ms%1000,3);
}
function bitrate(n) { return n>0 ? (n>=1000000 ? fixed(n/1000000,2)+' Mb/s' : fixed(n/1000,1)+' kb/s') : ''; }
function add(rows,key,value) { if (value!==undefined && value!==null && value!=='') rows.push([key,String(value)]); }
function bytes(data) {
  const s = str(data.base64EncodedStringWithOptions(0));
  if (!s) return new Uint8Array();
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out=[];
  let acc=0, bits=0;
  for (const c of s) {
    const v=alphabet.indexOf(c);
    if (v<0) break;
    acc=(acc<<6)|v; bits+=6;
    if (bits>=8) { bits-=8; out.push((acc>>>bits)&255); }
  }
  return new Uint8Array(out);
}
function ext(d,key) { return $.CMFormatDescriptionGetExtension(d,$(key)); }
function audioFormat(d, code) {
  const ptr=$.CMAudioFormatDescriptionGetStreamBasicDescription(d);
  if (!ptr || !ptr[0]) return {};
  // AudioStreamBasicDescription: Float64 sample rate, then eight UInt32 fields.
  const b=bytes($.NSData.dataWithBytesLength(ptr,40));
  if (b.length!==40) return {};
  const v=new DataView(b.buffer), flags=v.getUint32(12,true), channels=v.getUint32(28,true);
  let depth=v.getUint32(32,true);
  if (!depth && (code==='alac' || code==='flac')) depth=({1:16,2:20,3:24,4:32})[flags];
  return {rate:v.getFloat64(0,true), channels, depth, floating:code==='lpcm' && (flags&1)!==0};
}
function videoDepth(d, code) {
  const n=Number(str(ext(d,'BitsPerComponent')));
  if (n>=8 && n<=32) return n+' bits/channel';
  const atoms=ext(d,'SampleDescriptionExtensionAtoms');
  if (['apch','apcn','apcs','apco'].includes(code)) return '10 bits/channel';
  if (!atoms.isNil() && (code==='hvc1' || code==='hev1')) {
    const b=bytes(atoms.objectForKey('hvcC'));
    if (b.length>=23 && b[0]===1) {
      const l=8+(b[17]&7), c=8+(b[18]&7);
      return l===c ? l+' bits/channel' : l+'-bit luma / '+c+'-bit chroma';
    }
  }
  if (!atoms.isNil() && (code==='avc1' || code==='avc3')) {
    const b=bytes(atoms.objectForKey('avcC'));
    if (b[0]===1 && [66,77,88,100].includes(b[1])) return '8 bits/channel';
    if (b[0]===1 && b.length>=7) {
      // Skip SPS and PPS entries to find the optional AVC configuration extension.
      let p=6;
      const skip=count=>{while(count-- && p+1<b.length) p+=2+(b[p]<<8)+b[p+1];};
      skip(b[5]&31);
      if(p<b.length) skip(b[p++]);
      if(p+2<b.length && (b[p]&252)===252 && (b[p+1]&248)===248 && (b[p+2]&248)===248) {
        const l=8+(b[p+1]&7), c=8+(b[p+2]&7);
        return l===c ? l+' bits/channel' : l+'-bit luma / '+c+'-bit chroma';
      }
    }
  }
  return '';
}
function fps(n) {
  for (const [nom, exact] of [[23.976,24000],[29.970,30000],[47.952,48000],[59.940,60000],[119.880,120000]]) {
    if (Math.abs(n-exact/1001)<0.00003) return nom.toFixed(3)+' fps ('+exact+'/1001)';
  }
  return fixed(n,4)+' fps';
}
function trackInfo(t,type) {
  const rows=[], formats=t.formatDescriptions, list=[];
  for(let i=0;i<formats.count;i++){
    const d=formats.objectAtIndex(i), code=fourcc($.CMFormatDescriptionGetMediaSubType(d));
    const spec={codec:codecs[code]||code.trim()};
    if(type==='soun') Object.assign(spec,get(()=>audioFormat(d,code))||{});
    if(type==='vide') {
      spec.depth=get(()=>videoDepth(d,code));
      spec.fields=Number(str(ext(d,'CVFieldCount')));
      spec.primaries=str(ext(d,'CVImageBufferColorPrimaries'));
    }
    list.push(spec);
  }
  function variants(fn) { return [...new Set(list.map(fn).filter(Boolean))].join(' / '); }
  add(rows,'Codec',variants(x=>x.codec));
  if(type==='soun') {
    add(rows,'Sample rate',variants(x=>x.rate>0 ? fixed(x.rate,2).replace(/\B(?=(\d{3})+(?!\d))/g,',')+' Hz' : ''));
    add(rows,'Bit depth',variants(x=>x.depth>0 ? x.depth+'-bit'+(x.floating?' float':'') : '') || (list.length?'Not reported by codec':''));
    add(rows,'Channels',variants(x=>x.channels===1?'1 (mono)':x.channels===2?'2 (stereo)':x.channels>0?x.channels:''));
  } else {
    const size=t.naturalSize, transform=t.preferredTransform;
    if(size.width>0 && size.height>0) {
      const w=Math.round(size.width), h=Math.round(size.height);
      const rotated=transform && Math.abs(transform.b)>0.99 && Math.abs(transform.a)<0.01;
      add(rows,'Resolution',rotated ? h+' × '+w+' (display); '+w+' × '+h+' encoded' : w+' × '+h);
    }
    const rate=t.nominalFrameRate, interlaced=list.some(x=>x.fields===2);
    if(rate>0) add(rows, interlaced?'Nominal field rate':'Nominal frame rate', interlaced?fixed(rate,3)+' fields/s':fps(rate));
    add(rows,'Bit depth',variants(x=>x.depth)||'Not reported by codec');
    add(rows,'Color primaries',variants(x=>x.primaries && x.primaries.replace(/_/g,' ')));
  }
  let dataRate=t.estimatedDataRate;
  if(!(dataRate>0) && type==='soun' && list.length===1 && list[0].codec==='Linear PCM'){
    const a=list[0]; dataRate=a.rate*a.channels*a.depth;
  }
  add(rows,'Bit rate',bitrate(dataRate));
  add(rows,'Track duration',get(()=>duration($.CMTimeGetSeconds(t.timeRange.duration))));
  const language=str(t.extendedLanguageTag)||str(t.languageCode);
  if(language && language!=='und') add(rows,'Language',language);
  return rows;
}
function inspect(path) {
  const url=$.NSURL.fileURLWithPath(path), name=str(url.lastPathComponent)||path, suffix=(str(url.pathExtension)||'').toLowerCase();
  const attrs=$.NSFileManager.defaultManager.attributesOfItemAtPathError(path,null);
  const report={path,name,container:containers[suffix]||suffix.toUpperCase()||'File',size:'',duration:'',groups:[],note:''};
  if(attrs.isNil()) { report.note='This file could not be read. Check that it is available locally.'; return report; }
  const dateFormat=$.NSDateFormatter.alloc.init;
  dateFormat.dateStyle=2;
  dateFormat.timeStyle=2;
  for (const [field, key] of [['created',$.NSFileCreationDate],['modified',$.NSFileModificationDate]]) {
    const value=attrs.objectForKey(key);
    if(!value.isNil()) report[field]=str(dateFormat.stringFromDate(value));
  }
  if(str(attrs.objectForKey($.NSFileType))===str($.NSFileTypeDirectory)){
    report.note='Select an audio or video file to see its media metadata.'; return report;
  }
  report.canPreview=true;
  const count=Number(str(attrs.objectForKey($.NSFileSize)));
  if(Number.isFinite(count)) report.size=str($.NSByteCountFormatter.stringFromByteCountCountStyle(count,0));
  try {
    const options=$.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true),'AVURLAssetPreferPreciseDurationAndTimingKey');
    const asset=$.NSClassFromString('AVURLAsset').URLAssetWithURLOptions(url,options);
    const video=[],audio=[], tracks=asset.tracks;
    for (let i=0;i<tracks.count;i++) {
      const track=tracks.objectAtIndex(i),type=str(track.mediaType);
      if(type==='soun') audio.push(track);
      if(type==='vide') video.push(track);
    }
    if(audio.length || video.length) {
      report.duration=duration($.CMTimeGetSeconds(asset.duration));
      report.hasWaveform=audio.length>0 && video.length===0;
      for (const [type, label, items] of [['vide','Video',video],['soun','Audio',audio]]) {
        items.forEach((t,i)=>report.groups.push({title:items.length>1 ? label+' '+(i+1) : label, rows:trackInfo(t,type)}));
      }
    } else {
      report.note='No readable audio or video tracks. The file may use an unsupported format or may be unavailable.';
    }
  } catch (error) {
    report.note='Some media metadata could not be read from this file.';
    console.log(String(error));
  }
  return report;
}

function rect(x,y,w,h){return $.NSMakeRect(x,y,w,h);}
function label(parent,value,x,y,w,h,options={}) {
  const t=$.NSTextField.labelWithString(value);
  t.frame=rect(x,y,w,h);
  t.font=options.mono ? $.NSFont.monospacedDigitSystemFontOfSizeWeight(options.size||13,options.weight||0) :
    $.NSFont.systemFontOfSizeWeight(options.size||13,options.weight||0);
  t.textColor=options.color||$.NSColor.labelColor;
  t.lineBreakMode=options.wrap?0:4;
  t.maximumNumberOfLines=options.wrap?0:1;
  t.selectable=!!options.selectable;
  if(options.selectable) t.toolTip=value;
  parent.addSubview(t);
  return t;
}
function line(parent,x,y,w) {
  const l=$.NSBox.alloc.initWithFrame(rect(x,y,w,1));
  l.boxType=2; parent.addSubview(l);
}
function button(parent,title,x,y,w,action,key) {
  const b=$.NSButton.buttonWithTitleTargetAction(title,provider,action);
  b.bezelStyle=1; b.frame=rect(x,y,w,29);
  if(key) { b.keyEquivalent=key; b.keyEquivalentModifierMask=1<<20; }
  parent.addSubview(b);
  return b;
}
function fitWindow(w,h) {
  if(panel && panelIsPassive!==passiveInspector) {
    panel.orderOut(null);
    panel=undefined;
  }
  if (!panel) {
    const style=1|2|4|(passiveInspector ? Number($.NSWindowStyleMaskNonactivatingPanel) : 0);
    panel=$.ISeeYouPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect(0,0,w,h),style,2,false);
    panelIsPassive=passiveInspector;
    panel.becomesKeyOnlyIfNeeded=passiveInspector;
    panel.delegate=provider;
    panel.title=TITLE;
    panel.releasedWhenClosed=false;
    panel.level=3;
    panel.hidesOnDeactivate=false;
    panel.center;
  } else {
    const f=panel.frame, newFrame=panel.frameRectForContentRect(rect(0,0,w,h));
    const ideal=rect(f.origin.x,f.origin.y+f.size.height-newFrame.size.height,newFrame.size.width,newFrame.size.height);
    const screen=panel.screen;
    panel.setFrameDisplay(screen.isNil()?ideal:panel.constrainFrameRectToScreen(ideal,screen),true);
  }
  const root=$.NSView.alloc.initWithFrame(rect(0,0,w,h));
  panel.contentView=root;
  return root;
}
function show() {
  if(passiveInspector) {
    panel.orderFrontRegardless;
    return;
  }
  panel.makeKeyAndOrderFront(null);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
}
function openPreview(report) {
  if(previewPanel && previewPanel.visible) previewPanel.close;
  const screen=panel.screen;
  const width=screen.isNil()?680:Math.min(680,screen.visibleFrame.size.width-40);
  const height=screen.isNil()?430:Math.min(430,screen.visibleFrame.size.height-70);
  previewPanel=$.ISeeYouPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect(0,0,width,height),1|2|4|8,2,false);
  previewPanel.releasedWhenClosed=false;
  previewPanel.level=Number(panel.level)+1;
  previewPanel.title='Preview — '+report.name;
  const view=$.QLPreviewView.alloc.initWithFrame(rect(0,0,width,height));
  view.autostarts=false;
  view.shouldCloseWithWindow=true;
  previewPanel.contentView=view;
  view.previewItem=$.NSURL.fileURLWithPath(report.path);
  previewPanel.center;
  previewPanel.makeKeyAndOrderFront(null);
}
function drawWaveform(view, report) {
  for (const subview of ObjC.unwrap(view.subviews)) subview.removeFromSuperview;
  const {width,height}=view.bounds.size;
  if (!report.waveform || !report.waveform.length) {
    const status=report.waveform ? 'Waveform unavailable for this file.' : 'Reading waveform…';
    label(view,status,10,12,width-20,23,{color:$.NSColor.secondaryLabelColor});
    return;
  }
  const image=$.NSImage.alloc.initWithSize($.NSMakeSize(width,height));
  image.lockFocus;
  try {
    const bounds=rect(0,0,width,height);
    $.NSColor.controlBackgroundColor.setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(bounds,6,6).fill;
    const mid=height/2;
    const axis=$.NSBezierPath.bezierPath;
    axis.lineWidth=1;
    axis.moveToPoint($.NSMakePoint(10,mid));
    axis.lineToPoint($.NSMakePoint(width-10,mid));
    $.NSColor.separatorColor.setStroke;
    axis.stroke;

    const peaks=report.waveform;
    const scale=Math.max(0.1,...peaks);
    const step=(width-20)/peaks.length;
    const bars=$.NSBezierPath.bezierPath;
    bars.lineWidth=Math.min(2,step*0.58);
    bars.lineCapStyle=1;
    peaks.forEach((peak,index)=>{
      const x=10+(index+0.5)*step, amplitude=Math.max(0.5,(mid-6)*peak/scale);
      bars.moveToPoint($.NSMakePoint(x,mid-amplitude));
      bars.lineToPoint($.NSMakePoint(x,mid+amplitude));
    });
    ACCENT().setStroke;
    bars.stroke;
  } finally {
    image.unlockFocus;
  }
  const graph=$.NSImageView.imageViewWithImage(image);
  graph.frame=rect(0,0,width,height);
  graph.setAccessibilityLabel('Audio waveform showing sampled peak amplitude across the recording');
  graph.toolTip='Sampled peak levels, scaled to fit';
  view.addSubview(graph);
}
function render() {
  const {files, reports, active}=inspector();
  const report=reports[active], w=570;
  waveformView=undefined;
  currentReport=report && !report.loading ? report : undefined;
  if(!report) {
    const h=240, root=fitWindow(w,h);
    const badge=$.NSImage.imageWithSystemSymbolNameAccessibilityDescription('eye',TITLE);
    if(!badge.isNil()) {
      const v=$.NSImageView.imageViewWithImage(badge);
      v.frame=rect(29,174,37,37); v.contentTintColor=ACCENT(); root.addSubview(v);
    }
    label(root,'ISeeYou',82,183,440,29,{size:23,weight:0.3});
    label(root,'Detailed audio and video metadata',83,160,450,23,{color:$.NSColor.secondaryLabelColor});
    line(root,29,145,512);
    label(root,'Select a file in Finder and press ⇧⌘E.',30,100,510,25,{size:15,weight:0.23});
    label(root,'You can also choose Finder → Services → Show ISeeYou.',30,73,510,22,{color:$.NSColor.secondaryLabelColor});
    if(!hold) button(root,'Open File…',411,19,130,'choose:', 'o');
    return;
  }
  const multiple=files.length>1;
  const groups=report.loading?[]:[
    {title:'File',rows:[['Created',report.created||'—'],['Modified',report.modified||'—']]},
    ...report.groups
  ];
  const docH=groups.reduce((n,g)=>n+40+g.rows.length*27,0)+10+
    (report.hasWaveform?91:0)+(report.loading || report.note?66:0);
  const chrome=multiple?193:157;
  const screen=$.NSScreen.mainScreen;
  const maxH=screen.isNil()?665:Math.min(665,screen.visibleFrame.size.height-70);
  const scrollH=Math.min(Math.max(77,docH),Math.max(120,maxH-chrome));
  const h=scrollH+chrome, root=fitWindow(w,h);
  const icon=$.NSWorkspace.sharedWorkspace.iconForFile(report.path);
  const iconView=$.NSImageView.imageViewWithImage(icon);
  iconView.imageScaling=3;
  iconView.frame=rect(22,h-71,49,49); root.addSubview(iconView);
  label(root,report.name,83,h-46,463,29,{size:22,weight:0.3,selectable:true});
  label(root,[report.container,report.size].filter(Boolean).join('   ·   '),84,h-69,455,22,{color:$.NSColor.secondaryLabelColor});
  if(multiple) {
    const select=$.NSPopUpButton.alloc.initWithFramePullsDown(rect(79,h-105,461,27),false);
    files.forEach((f,i)=>select.addItemWithTitle((i+1)+'  ·  '+str($.NSURL.fileURLWithPath(f).lastPathComponent)));
    select.selectItemAtIndex(active);
    select.target=provider; select.action='selectFile:';
    root.addSubview(select);
  }
  const durationY=scrollH+73;
  line(root,26,durationY+28,518);
  label(root,'DURATION',28,durationY,135,20,{size:11,weight:0.35,color:ACCENT()});
  label(root,report.loading?'Reading…':(report.duration||'—'),164,durationY-3,370,25,{size:17,weight:0.23,mono:true,selectable:!report.loading});
  line(root,26,scrollH+63,518);

  const scroll=$.NSScrollView.alloc.initWithFrame(rect(23,57,524,scrollH));
  scroll.hasVerticalScroller=docH>scrollH; scroll.autohidesScrollers=true; scroll.drawsBackground=false;
  const doc=$.NSView.alloc.initWithFrame(rect(0,0,scroll.contentSize.width,Math.max(docH,scrollH)));
  scroll.documentView=doc;
  const docW=scroll.contentSize.width;
  let y=Math.max(docH,scrollH)-7;
  for (const group of groups) {
    y-=28;
    label(doc,group.title.toUpperCase(),6,y,docW-16,21,{size:11,weight:0.37,color:ACCENT()});
    for (const [key,val] of group.rows) {
      y-=27;
      label(doc,key,6,y,132,24,{color:$.NSColor.secondaryLabelColor});
      label(doc,val,141,y,docW-154,24,{selectable:true,mono:true});
      line(doc,6,y-1,docW-21);
    }
    y-=12;
    if(group===groups[0] && report.hasWaveform) {
      y-=25;
      label(doc,'WAVEFORM',6,y,docW-16,21,{size:11,weight:0.37,color:ACCENT()});
      waveformView=$.NSView.alloc.initWithFrame(rect(6,y-51,docW-21,47));
      doc.addSubview(waveformView);
      drawWaveform(waveformView,report);
      y-=66;
    }
  }
  if (report.loading || report.note) {
    label(doc,report.loading?'Reading file metadata…':report.note,6,y-54,docW-20,52,{wrap:true,color:$.NSColor.secondaryLabelColor});
  }
  root.addSubview(scroll);
  scroll.contentView.scrollToPoint($.NSMakePoint(0,Math.max(0,docH-scrollH)));
  scroll.reflectScrolledClipView(scroll.contentView);
  if(hold) {
    label(root,'Showing while the Stream Deck key is held',26,14,518,25,{color:$.NSColor.secondaryLabelColor});
  } else {
    line(root,26,52,518);
    button(root,'Open File…',22,12,107,'choose:','o');
    const preview=button(root,'Preview',182,12,96,'preview:','p');
    preview.enabled=!!report.canPreview;
    button(root,'Reveal in Finder',282,12,130,'reveal:');
    const copy=button(root,'Copy Details',417,12,129,'copyReport:','c');
    copy.enabled=!!currentReport;
  }
}
function stopWaveform() {
  if(!waveformJob) return;
  waveformJob.timer.invalidate;
  if(waveformJob.task.running) waveformJob.task.terminate;
  waveformJob=undefined;
}
function startWaveform(report) {
  if(!report || !report.hasWaveform || report.waveform || !waveformView || waveformJob) return;
  try {
    const script=$.NSBundle.mainBundle.pathForResourceOfType('Waveform','js');
    const task=$.NSTask.alloc.init, pipe=$.NSPipe.pipe;
    task.executableURL=$.NSURL.fileURLWithPath('/usr/bin/osascript');
    task.arguments=$.NSArray.arrayWithArray(['-l','JavaScript',str(script),report.path]);
    task.standardOutput=pipe;
    task.standardError=$.NSFileHandle.fileHandleWithNullDevice;
    if (!task.launchAndReturnError(null)) throw Error('Could not start waveform reader');
    const timer=$.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.08,provider,'pollWaveform:',null,true);
    $.NSRunLoop.mainRunLoop.addTimerForMode(timer,$.NSRunLoopCommonModes);
    waveformJob={task,pipe,timer,report,deadline:Date.now()+15000};
  } catch (_) {
    report.waveform=[];
    drawWaveform(waveformView,report);
  }
}
function newInspector(paths) {
  const files=[...new Set(paths.filter(p=>typeof p==='string' && p.startsWith('/')))];
  const reports=files.map(path=>({path,loading:true,name:str($.NSURL.fileURLWithPath(path).lastPathComponent),groups:[]}));
  return {files, reports, active:0};
}
function presentInspector(passive) {
  passiveInspector=passive;
  render();
  if(hold && readHoldRequest()?.token!==hold.token) return;
  show();
  schedule();
  const {reports, active}=inspector();
  startWaveform(reports[active]);
}
function hideInspector() {
  pending+=1;
  stopWaveform();
  if(panel) panel.orderOut(null);
}
function displayPaths(paths) {
  endHold(false);
  stopWaveform();
  if(previewPanel && previewPanel.visible) previewPanel.close;
  persistent=newInspector(paths);
  persistentVisible=true;
  presentInspector(false);
}
function schedule() {
  pending+=1;
  const {reports, active}=inspector();
  if(!reports[active]?.loading) return;
  const timer=$.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.04,provider,'readPending:',pending,false);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer,$.NSRunLoopCommonModes);
}
function streamDeckCommand(path) {
  const slash=path.lastIndexOf('/');
  const filename=path.slice(slash+1);
  const toggle=/^stream-deck-toggle-.*\.json$/i.test(filename);
  if(filename!==HOLD_FILENAME && !toggle) return null;
  if(path.slice(0,slash)!==streamDeckDirectory()) return {kind:'invalid'};
  if(!toggle) return {kind:'hold', path};
  const match=TOGGLE_FILENAME.exec(filename);
  return match ? {kind:'toggle', path, token:match[1].toLowerCase()} : {kind:'invalid'};
}
function readStreamDeckRequest(command) {
  const fm=$.NSFileManager.defaultManager;
  const directory=fm.attributesOfItemAtPathError(streamDeckDirectory(),null);
  if(directory.isNil() || str(directory.objectForKey($.NSFileType))!==str($.NSFileTypeDirectory)) return;
  const attrs=fm.attributesOfItemAtPathError(command.path,null);
  if(attrs.isNil() || str(attrs.objectForKey($.NSFileType))!==str($.NSFileTypeRegular) ||
     Number(str(attrs.objectForKey($.NSFileSize)))>1048576) return;
  const raw=$.NSString.stringWithContentsOfFileEncodingError(command.path,4,null);
  const request=get(()=>JSON.parse(str(raw)));
  if(!request || typeof request.token!=='string' || !REQUEST_TOKEN.test(request.token) ||
     !Number.isSafeInteger(request.expiresAt) || request.expiresAt<=Date.now() ||
     !Array.isArray(request.files) ||
     !request.files.every(path=>typeof path==='string' && path.startsWith('/') && !path.includes('\0'))) return;
  const token=request.token.toLowerCase();
  if(command.token && command.token!==token) return;
  const modified=Number(attrs.objectForKey($.NSFileModificationDate).timeIntervalSince1970);
  return {...request, token, modified};
}
function handleToggles(commands) {
  // LaunchServices can batch or reorder callbacks. The producer writes one file per
  // press in order, so drain queued files in their publication order.
  if(!commands.some(command=>readStreamDeckRequest(command))) return;
  const fm=$.NSFileManager.defaultManager;
  const directory=streamDeckDirectory();
  const names=fm.contentsOfDirectoryAtPathError(directory,null);
  if(names.isNil()) return;
  const queue=ObjC.deepUnwrap(names).map(name=>streamDeckCommand(directory+'/'+name))
    .filter(command=>command?.kind==='toggle')
    .map(command=>({command, request:readStreamDeckRequest(command)}))
    .filter(item=>item.request)
    .sort((a,b)=>a.request.modified-b.request.modified || a.request.expiresAt-b.request.expiresAt);
  let changed=false;
  for(const {command,request} of queue) {
    // Consume before applying the press so a failed removal cannot replay it.
    if(request.expiresAt<=Date.now() || !fm.removeItemAtPathError(command.path,null)) continue;
    if(consumedToggles.has(request.token)) continue;
    consumedToggles.add(request.token);
    persistentVisible=!persistentVisible;
    changed=true;
    if(persistentVisible && request.files.length) persistent=newInspector(request.files);
  }
  if(!changed || hold) return;
  stopWaveform();
  if(previewPanel && previewPanel.visible) previewPanel.close;
  if(persistentVisible) presentInspector(true);
  else hideInspector();
}
function endHold(restore) {
  if(!hold) return;
  hold=undefined;
  holdTimer.invalidate;
  holdTimer=undefined;
  hideInspector();
  if(restore && persistentVisible) presentInspector(true);
}
function readHoldRequest() {
  return readStreamDeckRequest({kind:'hold', path:streamDeckDirectory()+'/'+HOLD_FILENAME});
}
function syncHold() {
  const request=readHoldRequest();
  if(!request) {
    endHold(true);
    return;
  }
  if(hold?.token===request.token) return;
  stopWaveform();
  if(previewPanel && previewPanel.visible) previewPanel.close;
  const state=request.files.length ? newInspector(request.files) :
    {...persistent, reports:persistent.reports.slice()};
  hold={token:request.token, inspector:state};
  if(!holdTimer) {
    holdTimer=$.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.1,provider,'pollHold:',null,true);
    $.NSRunLoop.mainRunLoop.addTimerForMode(holdTimer,$.NSRunLoopCommonModes);
  }
  presentInspector(true);
}
function textReport(r) {
  const lines=[r.name,[r.container,r.size].filter(Boolean).join(' · ')];
  if(r.duration) lines.push('Duration: '+r.duration);
  if(r.created) lines.push('Created: '+r.created);
  if(r.modified) lines.push('Modified: '+r.modified);
  for(const g of r.groups) lines.push('',g.title,...g.rows.map(([k,v])=>k+': '+v));
  if(r.note) lines.push('',r.note);
  return lines.join('\n');
}
function pasteboardPaths(p) {
  const urls=p.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL),$.NSDictionary.dictionaryWithObjectForKey(true,$.NSPasteboardURLReadingFileURLsOnlyKey));
  if(!urls.isNil() && urls.count>0) return Array.from({length:urls.count},(_,i)=>str(urls.objectAtIndex(i).path));
  const legacy=ObjC.deepUnwrap(p.propertyListForType($.NSFilenamesPboardType));
  return Array.isArray(legacy)?legacy:[];
}
function versionParts(version) {
  const match = typeof version === 'string' && /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}
function updateResult(installed, release) {
  if (release && release.status === 404) return 'unpublished';
  if (!release || release.status !== 200) return 'failed';
  const current = versionParts(installed);
  const latest = versionParts(release.tag);
  if (!current || !latest) return 'failed';
  for (let i = 0; i < latest.length; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i] ? 'available' : 'current';
  }
  return 'current';
}
function showUpdateResult(installed, release) {
  const alert = $.NSAlert.alloc.init;
  let releaseURL;
  switch (updateResult(installed, release)) {
    case 'available':
      alert.messageText = TITLE + ' ' + release.tag.replace(/^v/, '') + ' is available';
      alert.informativeText = 'You’re running version ' + installed + '. Open GitHub to view and download the update.';
      releaseURL = RELEASES_URL + '/tag/' + release.tag;
      break;
    case 'current':
      alert.messageText = TITLE + ' is up to date';
      alert.informativeText = 'You’re running version ' + installed + '.';
      break;
    case 'unpublished':
      alert.messageText = 'No release is available yet';
      alert.informativeText = 'GitHub doesn’t have a published stable release of ' + TITLE + ' yet.';
      break;
    default:
      alert.messageText = 'Couldn’t check for updates';
      alert.informativeText = 'GitHub didn’t return usable release information. Try again in a moment.';
  }
  if (releaseURL) alert.addButtonWithTitle('View Release');
  alert.addButtonWithTitle('OK');
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  if (Number(alert.runModal) === 1000 && releaseURL) {
    $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(releaseURL));
  }
}
function checkForUpdates() {
  if (updateJob) return;
  const bundle = $.NSBundle.mainBundle;
  const installed = str(bundle.objectForInfoDictionaryKey('CFBundleShortVersionString')) || 'unknown';
  try {
    const script = str(bundle.pathForResourceOfType('CheckForUpdates', 'js'));
    const task = $.NSTask.alloc.init, pipe = $.NSPipe.pipe;
    task.executableURL = $.NSURL.fileURLWithPath('/usr/bin/osascript');
    task.arguments = $.NSArray.arrayWithArray(['-l', 'JavaScript', script]);
    task.standardOutput = pipe;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    if (!task.launchAndReturnError(null)) throw Error('Could not start update checker');
    const timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.15, provider, 'pollUpdate:', null, true);
    updateJob = {task, pipe, timer, installed, deadline: Date.now() + 15000};
    updateMenuItem.title = 'Checking for Updates…';
    updateMenuItem.enabled = false;
  } catch (_) {
    showUpdateResult(installed, null);
  }
}
function installStatusMenu(app) {
  statusItem=$.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
  const button=statusItem.button;
  const icon=$.NSImage.imageWithSystemSymbolNameAccessibilityDescription('eye',TITLE);
  if (icon.isNil()) {
    button.title=TITLE;
  } else {
    icon.template=true;
    button.image=icon;
  }
  button.toolTip=TITLE;
  button.setAccessibilityLabel(TITLE);

  const menu=$.NSMenu.alloc.initWithTitle(TITLE);
  menu.autoenablesItems=false;
  const open=menu.addItemWithTitleActionKeyEquivalent('Open File…','choose:','');
  open.target=provider;
  const show=menu.addItemWithTitleActionKeyEquivalent('Show '+TITLE,'showInspector:','');
  show.target=provider;
  menu.addItem($.NSMenuItem.separatorItem);
  updateMenuItem=menu.addItemWithTitleActionKeyEquivalent('Check for Updates…','checkForUpdates:','');
  updateMenuItem.target=provider;
  const quit=menu.addItemWithTitleActionKeyEquivalent('Quit '+TITLE,'terminate:','');
  quit.target=app;
  statusItem.menu=menu;
}
function setup() {
  if(provider) return;
  ObjC.registerSubclass({name:'ISeeYouPanel',superclass:'NSPanel',methods:{
    'cancelOperation:':{types:['void',['id']],implementation:function(){this.close;}}
  }});
  ObjC.registerSubclass({name:'ISeeYouServiceProvider',superclass:'NSObject',methods:{
    'inspect:userData:error:':{types:['void',['id','id','^@']],implementation:function(p,u,e){
      try {displayPaths(pasteboardPaths(p));} catch(error){console.log(String(error));}
    }},
    'pollHold:':{types:['void',['id']],implementation:syncHold},
    'windowWillClose:':{types:['void',['id']],implementation:function(notification){
      if(!panel || !notification.object.isEqual(panel)) return;
      panel=undefined;
      if(hold) {
        endHold(true);
      } else {
        persistentVisible=false;
        hideInspector();
      }
    }},
    'readPending:':{types:['void',['id']],implementation:function(timer){
      const {files,reports,active}=inspector();
      if(Number(str(timer.userInfo))!==pending || !reports[active] || !reports[active].loading) return;
      reports[active]=inspect(files[active]);
      if(panel && panel.visible) { render(); startWaveform(reports[active]); }
    }},
    'pollWaveform:':{types:['void',['id']],implementation:function(){
      const job=waveformJob;
      if(!job) return;
      if(job.task.running && Date.now()<job.deadline) return;
      let peaks=[];
      if(!job.task.running && Number(job.task.terminationStatus)===0) {
        const data=job.pipe.fileHandleForReading.readDataToEndOfFile;
        peaks=get(()=>JSON.parse(str($.NSString.alloc.initWithDataEncoding(data,4))))||[];
      }
      stopWaveform();
      job.report.waveform=peaks;
      const {reports,active}=inspector();
      if(reports[active]===job.report && waveformView && panel && panel.visible) drawWaveform(waveformView,job.report);
    }},
    'selectFile:':{types:['void',['id']],implementation:function(sender){
      stopWaveform();
      if(previewPanel && previewPanel.visible) previewPanel.close;
      const state=inspector();
      state.active=Number(sender.indexOfSelectedItem);
      render();
      schedule();
      startWaveform(state.reports[state.active]);
    }},
    'choose:':{types:['void',['id']],implementation:function(){
      $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
      const dialog=$.NSOpenPanel.openPanel;
      dialog.title='Choose media to inspect';
      dialog.prompt='Inspect';
      dialog.allowsMultipleSelection=true;
      dialog.canChooseDirectories=false;
      if(Number(dialog.runModal)===1) {
        const urls=dialog.URLs;
        displayPaths(Array.from({length:urls.count},(_,i)=>str(urls.objectAtIndex(i).path)));
      }
    }},
    'showInspector:':{types:['void',['id']],implementation:function(){
      endHold(false);
      persistentVisible=true;
      presentInspector(false);
    }},
    'checkForUpdates:':{types:['void',['id']],implementation:checkForUpdates},
    'pollUpdate:':{types:['void',['id']],implementation:function(){
      const job = updateJob;
      if (!job || (job.task.running && Date.now() < job.deadline)) return;
      job.timer.invalidate;
      let release;
      if (job.task.running) {
        job.task.terminate;
      } else if (Number(job.task.terminationStatus) === 0) {
        release = get(() => {
          const data = job.pipe.fileHandleForReading.readDataToEndOfFile;
          return JSON.parse(str($.NSString.alloc.initWithDataEncoding(data, 4)));
        });
      }
      updateJob = undefined;
      updateMenuItem.title = 'Check for Updates…';
      updateMenuItem.enabled = true;
      showUpdateResult(job.installed, release);
    }},
    'reveal:':{types:['void',['id']],implementation:function(){
      const {files,active}=inspector();
      const path=files[active];
      if(path) $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(path)));
    }},
    'preview:':{types:['void',['id']],implementation:function(){
      if(currentReport && currentReport.canPreview) openPreview(currentReport);
    }},
    'copyReport:':{types:['void',['id']],implementation:function(sender){
      if(!currentReport) return;
      const p=$.NSPasteboard.generalPasteboard;
      p.clearContents;
      p.setStringForType(textReport(currentReport),$.NSPasteboardTypeString);
      sender.title='Copied';
    }}
  }});
  provider=$.ISeeYouServiceProvider.alloc.init;
  const app=$.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  app.servicesProvider=provider;
  installStatusMenu(app);
  $.NSUpdateDynamicServices();
}
function run(argv) {
  setup();
  if(Array.isArray(argv)&&argv.length) openDocuments(argv);
}
function openDocuments(items) {
  setup();
  const files=[], toggles=[];
  let holdNotification=false;
  for(const item of items) {
    const path=String(item);
    const command=streamDeckCommand(path);
    if(!command) files.push(path);
    else if(command.kind==='toggle') toggles.push(command);
    else if(command.kind==='hold') holdNotification=true;
  }
  if(toggles.length) handleToggles(toggles);
  if(holdNotification) syncHold();
  if(files.length) displayPaths(files);
}
function reopen(){ setup(); provider.showInspector(null); }
function idle(){ setup(); return 20; }
