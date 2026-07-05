const socket = io();

let pc = null, localStream = null, remoteUserId = null, pendingIce = [];
let muted = false, cameraOff = false, usingFrontCamera = true, currentMode = "voice";
let callTimer = null, callStartTime = null, ringtoneCtx = null, ringtoneOsc = null, ringtoneGain = null;
let myPhoto = "";

const loginBox = document.getElementById("loginBox"), mainBox = document.getElementById("mainBox");
const nameInput = document.getElementById("nameInput"), photoInput = document.getElementById("photoInput"), joinBtn = document.getElementById("joinBtn");
const usersList = document.getElementById("usersList"), historyList = document.getElementById("historyList"), refreshHistoryBtn = document.getElementById("refreshHistoryBtn");
const callBox = document.getElementById("callBox"), callTitle = document.getElementById("callTitle"), callStatus = document.getElementById("callStatus"), callDuration = document.getElementById("callDuration");
const callPhoto = document.getElementById("callPhoto"), avatarIcon = document.getElementById("avatarIcon");
const remoteAudio = document.getElementById("remoteAudio"), remoteVideo = document.getElementById("remoteVideo"), localVideo = document.getElementById("localVideo");
const acceptBtn = document.getElementById("acceptBtn"), rejectBtn = document.getElementById("rejectBtn"), muteBtn = document.getElementById("muteBtn"), cameraBtn = document.getElementById("cameraBtn"), flipBtn = document.getElementById("flipBtn"), speakerBtn = document.getElementById("speakerBtn"), endBtn = document.getElementById("endBtn");

const rtcConfig = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: ["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443","turns:openrelay.metered.ca:443"], username: "openrelayproject", credential: "openrelayproject" }
]};

joinBtn.onclick = join;
joinBtn.onclick = async () => {

    try {

        await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });

        alert("Mic Permission Granted");

    } catch(e) {

        alert(
            e.name + "\n" +
            e.message + "\n\n" +
            "Secure : " + window.isSecureContext + "\n" +
            "Protocol : " + location.protocol + "\n" +
            "MediaDevices : " + !!navigator.mediaDevices
        );

    }

    join();

};
refreshHistoryBtn.onclick = loadHistory;
nameInput.addEventListener("keydown", e => { if (e.key === "Enter") join(); });
document.addEventListener("click", unlockMedia);
document.addEventListener("touchstart", unlockMedia);

function unlockMedia(){ remoteAudio.play().catch(()=>{}); remoteVideo.play().catch(()=>{}); }
function readPhotoFile(file){ return new Promise(resolve=>{ if(!file) return resolve(""); const r=new FileReader(); r.onload=()=>resolve(r.result); r.readAsDataURL(file); }); }

async function join(){
  const name = nameInput.value.trim();
  if(!name) return alert("Enter your name");
  myPhoto = await readPhotoFile(photoInput.files[0]);
  socket.emit("user:join", { name, photo: myPhoto });
  loginBox.classList.add("hidden"); mainBox.classList.remove("hidden"); loadHistory();
}

socket.on("users:update", users => {
  usersList.innerHTML = "";
  const others = users.filter(u => u.socketId !== socket.id);
  if(!others.length){ usersList.innerHTML = `<p class="hint">No users online. Open another phone/tab and join.</p>`; return; }
  for(const user of others){
    const div=document.createElement("div"); div.className="user";
    const img = user.photo ? `<img class="userPhoto" src="${user.photo}">` : `<div class="userPhoto"></div>`;
    div.innerHTML = `<div class="userLeft">${img}<div><div class="name">${escapeHtml(user.name)}</div><div class="${user.busy?'busy':'online'}">${user.busy?'Busy':'Online'}</div></div></div><div class="userBtns"><button class="voiceBtn" ${user.busy?'disabled':''}>📞</button><button class="videoBtn" ${user.busy?'disabled':''}>📹</button></div>`;
    div.querySelector(".voiceBtn").onclick = () => startCall(user.socketId, user.name, user.photo, "voice");
    div.querySelector(".videoBtn").onclick = () => startCall(user.socketId, user.name, user.photo, "video");
    usersList.appendChild(div);
  }
});

async function getMedia(mode){
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Browser does not support microphone/camera.\nSecure: " + window.isSecureContext);
      throw new Error("getUserMedia not supported");
    }

    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === "video" ? { facingMode: usingFrontCamera ? "user" : "environment" } : false
    });

  } catch(err) {
    alert(
      (mode === "video" ? "CAMERA/MIC ERROR:\n" : "MIC ERROR:\n") +
      err.name + "\n" +
      err.message + "\n\n" +
      "Secure: " + window.isSecureContext + "\n" +
      "Protocol: " + location.protocol
    );
    throw err;
  }
}


async function createPeer(to, mode){
  cleanupPeerOnly();
  currentMode = mode;
  pc = new RTCPeerConnection(rtcConfig);
  localStream = await getMedia(mode);
  if(mode==="video"){ localVideo.srcObject = localStream; localVideo.classList.remove("hidden"); localVideo.play().catch(()=>{}); }
  for(const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.ontrack = e => {
    const stream = e.streams[0]; if(!stream) return;
    if(currentMode==="video"){ remoteVideo.srcObject=stream; remoteVideo.classList.remove("hidden"); remoteVideo.play().catch(()=> callStatus.textContent="Connected - screen tap cheyyi"); }
    else { remoteAudio.srcObject=stream; remoteAudio.muted=false; remoteAudio.volume=1; remoteAudio.play().catch(()=> callStatus.textContent="Connected - screen tap cheyyi"); }
  };
  pc.onicecandidate = e => { if(e.candidate) socket.emit("webrtc:ice", { to, candidate:e.candidate }); };
  pc.oniceconnectionstatechange = () => {
    if(!pc) return;
    if(pc.iceConnectionState==="connected" || pc.iceConnectionState==="completed") onConnected();
    if(pc.iceConnectionState==="failed"){ callStatus.textContent="Connection failed"; setTimeout(()=>closeCall(false),900); }
  };
  pc.onconnectionstatechange = () => {
    if(!pc) return;
    if(pc.connectionState==="connected") onConnected();
    if(pc.connectionState==="failed" || pc.connectionState==="closed") closeCall(false);
  };
}

function onConnected(){
  stopRingtone(); callTitle.textContent = currentMode==="video" ? "" : "Connected"; callStatus.textContent="Connected";
  muteBtn.classList.remove("hidden"); speakerBtn.classList.remove("hidden"); endBtn.classList.remove("hidden");
  if(currentMode==="video"){ cameraBtn.classList.remove("hidden"); flipBtn.classList.remove("hidden"); callBox.classList.add("videoMode"); }
  if(!callTimer) startTimer();
}

async function startCall(id,name,photo,mode){
  try{
    remoteUserId=id; currentMode=mode; unlockMedia();
    showCall(name, mode==="video" ? "Video ringing..." : "Ringing...", photo, mode);
    endBtn.classList.remove("hidden"); startRingtone(false);
    await createPeer(id,mode);
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo: mode==="video" });
    await pc.setLocalDescription(offer);
    socket.emit("call:request", { to:id, offer, mode });
  }catch(err){ console.error(err); closeCall(true); }
}

socket.on("call:incoming", ({from, callerName, callerPhoto, offer, mode}) => {
  remoteUserId=from; currentMode=mode||"voice";
  showCall(callerName, currentMode==="video" ? "Incoming video call" : "Incoming voice call", callerPhoto, currentMode);
  acceptBtn.classList.remove("hidden"); rejectBtn.classList.remove("hidden"); startRingtone(true);
  acceptBtn.onclick = async () => {
    try{
      unlockMedia(); stopRingtone(); acceptBtn.classList.add("hidden"); rejectBtn.classList.add("hidden");
      await createPeer(from,currentMode);
      await pc.setRemoteDescription(new RTCSessionDescription(offer)); await flushPendingIce();
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      socket.emit("call:accept", { to:from, answer, mode:currentMode });
      callTitle.textContent = currentMode==="video" ? "" : callerName; callStatus.textContent="Connecting...";
    }catch(err){ console.error(err); socket.emit("call:end", { to:from, mode:currentMode }); closeCall(false); }
  };
  rejectBtn.onclick = () => { stopRingtone(); socket.emit("call:reject", { to:from, mode:currentMode }); closeCall(false); };
});

socket.on("call:accepted", async ({answer, mode}) => {
  stopRingtone();
  try{ if(!pc) return; currentMode=mode||currentMode; await pc.setRemoteDescription(new RTCSessionDescription(answer)); await flushPendingIce(); callStatus.textContent="Connecting..."; }
  catch(err){ console.error(err); }
});

socket.on("webrtc:ice", async ({candidate}) => {
  if(!candidate) return; const ice = new RTCIceCandidate(candidate);
  if(!pc || !pc.remoteDescription){ pendingIce.push(ice); return; }
  try{ await pc.addIceCandidate(ice); }catch(err){ console.error("ICE error",err); }
});

socket.on("call:rejected",()=>{ alert("Call rejected"); closeCall(false); });
socket.on("call:ended",()=>closeCall(false));
socket.on("call:error",msg=>{ alert(msg); closeCall(false); });

endBtn.onclick = () => closeCall(true);
muteBtn.onclick = () => { if(!localStream) return; muted=!muted; localStream.getAudioTracks().forEach(t=>t.enabled=!muted); muteBtn.textContent = muted ? "🔇" : "🎤"; };
cameraBtn.onclick = () => { if(!localStream) return; cameraOff=!cameraOff; localStream.getVideoTracks().forEach(t=>t.enabled=!cameraOff); cameraBtn.textContent = cameraOff ? "📷" : "📹"; };
flipBtn.onclick = async () => {
  if(currentMode!=="video" || !pc) return; usingFrontCamera=!usingFrontCamera;
  const newStream = await getMedia("video"); const newTrack = newStream.getVideoTracks()[0];
  const sender = pc.getSenders().find(s=>s.track && s.track.kind==="video");
  if(sender && newTrack) await sender.replaceTrack(newTrack);
  localStream.getVideoTracks().forEach(t=>t.stop());
  localStream = new MediaStream([...localStream.getAudioTracks(), newTrack]);
  localVideo.srcObject = localStream;
};
speakerBtn.onclick = () => alert("Speaker control phone/browser settings lo untundhi.");

async function flushPendingIce(){ for(const ice of pendingIce){ try{ if(pc) await pc.addIceCandidate(ice); }catch(err){ console.error(err); } } pendingIce=[]; }

function showCall(title,status,photo="",mode="voice"){
  callTitle.textContent=title; callStatus.textContent=status; callBox.classList.toggle("videoMode", mode==="video");
  if(photo){ callPhoto.src=photo; callPhoto.classList.remove("hidden"); avatarIcon.classList.add("hidden"); }
  else{ callPhoto.classList.add("hidden"); avatarIcon.classList.remove("hidden"); }
  callDuration.classList.add("hidden"); callDuration.textContent="00:00"; callBox.classList.remove("hidden");
}

function cleanupPeerOnly(){
  if(pc){ pc.ontrack=null; pc.onicecandidate=null; pc.oniceconnectionstatechange=null; pc.onconnectionstatechange=null; pc.close(); }
  if(localStream) localStream.getTracks().forEach(t=>t.stop());
  pc=null; localStream=null;
}

function closeCall(sendEnd){
  stopRingtone(); stopTimer();
  if(sendEnd && remoteUserId) socket.emit("call:end", { to:remoteUserId, mode:currentMode });
  cleanupPeerOnly();
  remoteUserId=null; pendingIce=[]; muted=false; cameraOff=false;
  remoteAudio.pause(); remoteAudio.srcObject=null; remoteVideo.pause(); remoteVideo.srcObject=null; remoteVideo.classList.add("hidden");
  localVideo.pause(); localVideo.srcObject=null; localVideo.classList.add("hidden");
  callBox.classList.remove("videoMode"); callBox.classList.add("hidden");
  [acceptBtn,rejectBtn,muteBtn,cameraBtn,flipBtn,speakerBtn,endBtn].forEach(b=>b.classList.add("hidden"));
  muteBtn.textContent="🎤"; cameraBtn.textContent="📹"; callDuration.classList.add("hidden"); callDuration.textContent="00:00";
  loadHistory();
}

function startTimer(){
  stopTimer(); callStartTime=Date.now(); callStatus.textContent="Connected"; callDuration.classList.remove("hidden"); callDuration.textContent="00:00";
  callTimer=setInterval(()=>{ const e=Math.floor((Date.now()-callStartTime)/1000); const m=String(Math.floor(e/60)).padStart(2,"0"); const s=String(e%60).padStart(2,"0"); callDuration.textContent=`${m}:${s}`; },1000);
}
function stopTimer(){ if(callTimer) clearInterval(callTimer); callTimer=null; callStartTime=null; }

async function loadHistory(){
  try{
    const res = await fetch("/call-history"); if(!res.ok) throw new Error();
    const list = await res.json();
    historyList.innerHTML = list.length ? list.map(h=>`<div class="historyItem"><b>${escapeHtml(h.type)} - ${escapeHtml(h.mode||"voice")}</b><br>${escapeHtml(h.fromName)} → ${escapeHtml(h.toName)}<br><small>${escapeHtml(h.time)}</small></div>`).join("") : `<p class="hint">No call history</p>`;
  }catch{ historyList.innerHTML = `<p class="hint">No call history</p>`; }
}

function startRingtone(vibrate){
  stopRingtone();
  try{ ringtoneCtx=new (window.AudioContext||window.webkitAudioContext)(); ringtoneOsc=ringtoneCtx.createOscillator(); ringtoneGain=ringtoneCtx.createGain(); ringtoneOsc.type="sine"; ringtoneOsc.frequency.value=440; ringtoneGain.gain.value=.015; ringtoneOsc.connect(ringtoneGain); ringtoneGain.connect(ringtoneCtx.destination); ringtoneOsc.start(); }catch{}
  if(vibrate && navigator.vibrate) navigator.vibrate([250,150,250,150,250]);
}
function stopRingtone(){ try{ if(ringtoneOsc) ringtoneOsc.stop(); if(ringtoneCtx) ringtoneCtx.close(); }catch{} ringtoneOsc=null; ringtoneGain=null; ringtoneCtx=null; }
function escapeHtml(str){ return String(str??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
