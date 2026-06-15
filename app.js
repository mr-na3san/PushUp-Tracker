'use strict';

const CIRCUMFERENCE = 2 * Math.PI * 52;

const POSE_LANDMARKS = {
  nose: 0,
  leftEye: 1, rightEye: 2,
  leftEar: 3, rightEar: 4,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28
};

const SKELETON_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26],
  [25, 27], [26, 28]
];

const appState = {
  isRunning: false,
  repCount: 0,
  pushupState: 'UP',
  formScore: 0,
  repProgress: 0,
  fps: 0,
  confidence: 0,
  sessionStart: null,
  sessionDuration: 0,
  formScoreHistory: [],
  lastRepTime: null,
  rpmHistory: [],
  stableFrames: 0,
  smoothedAngle: 180
};

const settings = {
  sensitivity: 0.6,
  confidenceThreshold: 0.5,
  showSkeleton: true,
  soundEnabled: true,
  mirrorCamera: true,
  theme: 'dark',
  cameraDeviceId: ''
};

const storageKey = 'pushup_tracker_v2';

let audioCtx = null;
let deferredInstallPrompt = null;
let pose = null;
let mediaCamera = null;
let videoEl, canvasEl, canvasCtx;
let fpsFrameCount = 0;
let fpsLastTime = 0;
let sessionTimerInterval = null;

function showConfirm({ title, desc, danger = false, onConfirm }) {
  const modal = document.getElementById('confirmModal');
  const iconWrap = document.getElementById('confirmIconWrap');
  const okBtn = document.getElementById('confirmOkBtn');

  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmDesc').textContent = desc;

  if (danger) {
    iconWrap.classList.add('danger');
    document.getElementById('confirmIcon').innerHTML = '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>';
    okBtn.className = 'ctrl-btn confirm-danger';
  } else {
    iconWrap.classList.remove('danger');
    document.getElementById('confirmIcon').innerHTML = '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
    okBtn.className = 'ctrl-btn primary';
  }

  modal.classList.add('open');

  const cleanup = () => {
    modal.classList.remove('open');
    okBtn.removeEventListener('click', handleOk);
    document.getElementById('confirmCancelBtn').removeEventListener('click', handleCancel);
    modal.removeEventListener('click', handleOverlay);
  };

  const handleOk = () => { cleanup(); onConfirm(); };
  const handleCancel = () => cleanup();
  const handleOverlay = (e) => { if (e.target === modal) cleanup(); };

  okBtn.addEventListener('click', handleOk);
  document.getElementById('confirmCancelBtn').addEventListener('click', handleCancel);
  modal.addEventListener('click', handleOverlay);
}


  try {
    const stored = localStorage.getItem(storageKey + '_settings');
    if (stored) Object.assign(settings, JSON.parse(stored));
  } catch {}
}

function saveSettings() {
  try {
    localStorage.setItem(storageKey + '_settings', JSON.stringify(settings));
  } catch {}
}

function loadStats() {
  try {
    const stored = localStorage.getItem(storageKey + '_stats');
    return stored ? JSON.parse(stored) : getDefaultStats();
  } catch {
    return getDefaultStats();
  }
}

function getDefaultStats() {
  return {
    totalReps: 0,
    bestSession: 0,
    totalDurationSec: 0,
    avgFormScore: 0,
    totalCalories: 0,
    sessions: []
  };
}

function saveStats(stats) {
  try {
    localStorage.setItem(storageKey + '_stats', JSON.stringify(stats));
  } catch {}
}

function calcAngle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAb = Math.sqrt(ab.x * ab.x + ab.y * ab.y);
  const magCb = Math.sqrt(cb.x * cb.x + cb.y * cb.y);
  if (magAb === 0 || magCb === 0) return 180;
  const cos = Math.max(-1, Math.min(1, dot / (magAb * magCb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function getLandmarkPoint(landmarks, index) {
  const lm = landmarks[index];
  if (!lm) return null;
  return { x: lm.x, y: lm.y, z: lm.z || 0, visibility: lm.visibility || 0 };
}

function analyzeForm(landmarks) {
  const lShoulder = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftShoulder);
  const rShoulder = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightShoulder);
  const lElbow = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftElbow);
  const rElbow = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightElbow);
  const lWrist = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftWrist);
  const rWrist = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightWrist);
  const lHip = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftHip);
  const rHip = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightHip);
  const lKnee = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftKnee);
  const rKnee = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightKnee);
  const lAnkle = getLandmarkPoint(landmarks, POSE_LANDMARKS.leftAnkle);
  const rAnkle = getLandmarkPoint(landmarks, POSE_LANDMARKS.rightAnkle);

  if (!lShoulder || !rShoulder || !lElbow || !rElbow || !lWrist || !rWrist || !lHip || !rHip) {
    return { score: 0, feedback: 'Position body in frame', type: 'neutral', leftAngle: 180, rightAngle: 180, avgAngle: 180 };
  }

  const minVis = Math.min(
    lShoulder.visibility, rShoulder.visibility,
    lElbow.visibility, rElbow.visibility,
    lWrist.visibility, rWrist.visibility
  );

  if (minVis < settings.confidenceThreshold) {
    return { score: 0, feedback: 'Position body in frame', type: 'neutral', leftAngle: 180, rightAngle: 180, avgAngle: 180 };
  }

  const leftAngle = calcAngle(lShoulder, lElbow, lWrist);
  const rightAngle = calcAngle(rShoulder, rElbow, rWrist);
  const avgAngle = (leftAngle + rightAngle) / 2;

  let score = 100;
  let feedback = 'Good Form';
  let type = 'positive';

  const midShoulderY = (lShoulder.y + rShoulder.y) / 2;
  const midHipY = (lHip.y + rHip.y) / 2;
  const midAnkleY = lAnkle && rAnkle ? (lAnkle.y + rAnkle.y) / 2 : null;

  if (midAnkleY !== null) {
    const bodyLine = midHipY - midShoulderY;
    const totalLen = midAnkleY - midShoulderY;
    if (totalLen > 0) {
      const hipRatio = bodyLine / totalLen;
      if (hipRatio < 0.3) {
        score -= 25;
        feedback = 'Raise Hips Slightly';
        type = 'warning';
      } else if (hipRatio > 0.6) {
        score -= 20;
        feedback = 'Keep Back Straight';
        type = 'warning';
      }
    }
  }

  const angleDiff = Math.abs(leftAngle - rightAngle);
  if (angleDiff > 20) {
    score -= 15;
    if (type === 'positive') {
      feedback = 'Asymmetrical Movement';
      type = 'warning';
    }
  }

  const lKneePoint = lKnee;
  const rKneePoint = rKnee;
  if (lKneePoint && rKneePoint && midAnkleY !== null) {
    const midKneeY = (lKneePoint.y + rKneePoint.y) / 2;
    const kneeSag = midKneeY - midHipY;
    if (kneeSag > 0.05) {
      score -= 10;
    }
  }

  if (avgAngle > 100 && avgAngle < 150) {
    score -= 10;
    if (type === 'positive') {
      feedback = 'Go Lower';
      type = 'warning';
    }
  }

  if (avgAngle > 150 && avgAngle < 165) {
    score -= 5;
    if (type === 'positive') {
      feedback = 'Full Extension Needed';
      type = 'warning';
    }
  }

  score = Math.max(0, Math.min(100, score));

  if (score >= 85) { feedback = 'Good Form'; type = 'positive'; }
  else if (score >= 60 && type === 'positive') { feedback = 'Decent Form'; type = 'warning'; }
  else if (score < 40) { type = 'negative'; }

  return { score, feedback, type, leftAngle, rightAngle, avgAngle };
}

function smoothAngle(newAngle) {
  const alpha = 0.3;
  appState.smoothedAngle = alpha * newAngle + (1 - alpha) * appState.smoothedAngle;
  return appState.smoothedAngle;
}

function processPushup(avgAngle, formResult) {
  if (formResult.score < 10) {
    appState.stableFrames = 0;
    updateStatusUI('waiting', 'Waiting');
    return;
  }

  appState.stableFrames++;
  if (appState.stableFrames < 3) return;

  const upperThreshold = 155;
  const lowerThreshold = 85;

  const rawProgress = 1 - Math.min(1, Math.max(0, (avgAngle - lowerThreshold) / (upperThreshold - lowerThreshold)));
  appState.repProgress = rawProgress;

  if (appState.pushupState === 'UP' && avgAngle > upperThreshold) {
    updateStatusUI('ready', 'Ready');
  }

  if (avgAngle <= lowerThreshold && appState.pushupState === 'UP') {
    appState.pushupState = 'DOWN';
    updateStatusUI('in-motion', 'In Motion');
  } else if (avgAngle >= upperThreshold && appState.pushupState === 'DOWN') {
    appState.pushupState = 'UP';
    completedRep(formResult);
  } else if (appState.pushupState === 'DOWN') {
    updateStatusUI('in-motion', 'In Motion');
  } else if (avgAngle > upperThreshold) {
    updateStatusUI('ready', 'Ready');
  } else {
    updateStatusUI('in-motion', 'In Motion');
  }
}

function completedRep(formResult) {
  appState.repCount++;
  const now = Date.now();
  appState.formScoreHistory.push(formResult.score);

  if (appState.lastRepTime) {
    const elapsed = (now - appState.lastRepTime) / 1000;
    if (elapsed > 0 && elapsed < 30) {
      appState.rpmHistory.push(60 / elapsed);
      if (appState.rpmHistory.length > 10) appState.rpmHistory.shift();
    }
  }
  appState.lastRepTime = now;

  updateStatusUI('completed', 'Rep Completed');
  playRepSound();

  const repCounterEl = document.getElementById('repCounter');
  repCounterEl.classList.add('bump');
  setTimeout(() => repCounterEl.classList.remove('bump'), 150);

  document.getElementById('repCounter').textContent = appState.repCount;

  const avgForm = appState.formScoreHistory.reduce((a, b) => a + b, 0) / appState.formScoreHistory.length;
  updateFormScore(Math.round(avgForm));

  setTimeout(() => {
    if (appState.pushupState === 'UP') {
      updateStatusUI('ready', 'Ready');
    }
  }, 800);
}

function updateStatusUI(state, text) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  dot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function updateFormScore(score) {
  const el = document.getElementById('formScore');
  el.textContent = score;
  el.className = 'metric-value form-score';
  if (score >= 80) el.classList.add('good');
  else if (score >= 55) el.classList.add('fair');
  else el.classList.add('poor');
}

function updateFeedbackBar(text, type) {
  const bar = document.getElementById('formFeedbackBar');
  const textEl = document.getElementById('formFeedbackText');
  const icon = document.getElementById('feedbackIcon');
  bar.className = 'form-feedback-bar';
  if (type === 'positive') {
    bar.classList.add('positive');
    icon.innerHTML = '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
  } else if (type === 'warning') {
    bar.classList.add('warning');
    icon.innerHTML = '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
  } else if (type === 'negative') {
    bar.classList.add('negative');
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>';
  } else {
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>';
  }
  textEl.textContent = text;
}

function updateProgressRing(progress) {
  const ring = document.getElementById('progressRing');
  const pct = document.getElementById('repProgress');
  const offset = CIRCUMFERENCE * (1 - progress);
  ring.style.strokeDashoffset = offset;
  pct.textContent = Math.round(progress * 100) + '%';
}

function drawSkeleton(landmarks, canvasWidth, canvasHeight) {
  if (!settings.showSkeleton) return;
  canvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);

  const getPos = (index) => {
    const lm = landmarks[index];
    if (!lm || lm.visibility < 0.3) return null;
    return { x: lm.x * canvasWidth, y: lm.y * canvasHeight, v: lm.visibility };
  };

  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  for (const [i, j] of SKELETON_CONNECTIONS) {
    const a = getPos(i);
    const b = getPos(j);
    if (!a || !b) continue;
    const avgVis = (a.v + b.v) / 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(a.x, a.y);
    canvasCtx.lineTo(b.x, b.y);
    canvasCtx.strokeStyle = `rgba(132, 204, 22, ${0.5 + avgVis * 0.5})`;
    canvasCtx.lineWidth = 5;
    canvasCtx.stroke();
  }

  const jointGroups = [
    { indices: [POSE_LANDMARKS.leftShoulder, POSE_LANDMARKS.rightShoulder], color: '#84cc16', r: 10 },
    { indices: [POSE_LANDMARKS.leftElbow, POSE_LANDMARKS.rightElbow], color: '#f97316', r: 10 },
    { indices: [POSE_LANDMARKS.leftWrist, POSE_LANDMARKS.rightWrist], color: '#84cc16', r: 8 },
    { indices: [POSE_LANDMARKS.leftHip, POSE_LANDMARKS.rightHip], color: '#84cc16', r: 9 },
    { indices: [POSE_LANDMARKS.leftKnee, POSE_LANDMARKS.rightKnee], color: '#84cc16', r: 8 },
    { indices: [POSE_LANDMARKS.leftAnkle, POSE_LANDMARKS.rightAnkle], color: '#84cc16', r: 7 }
  ];

  for (const group of jointGroups) {
    for (const idx of group.indices) {
      const p = getPos(idx);
      if (!p) continue;
      canvasCtx.beginPath();
      canvasCtx.arc(p.x, p.y, group.r, 0, Math.PI * 2);
      canvasCtx.fillStyle = group.color;
      canvasCtx.fill();
      canvasCtx.beginPath();
      canvasCtx.arc(p.x, p.y, group.r + 3, 0, Math.PI * 2);
      canvasCtx.strokeStyle = 'rgba(255,255,255,0.5)';
      canvasCtx.lineWidth = 2;
      canvasCtx.stroke();
    }
  }

  const headPos = getPos(POSE_LANDMARKS.nose);
  if (headPos) {
    canvasCtx.beginPath();
    canvasCtx.arc(headPos.x, headPos.y, 12, 0, Math.PI * 2);
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fill();
    canvasCtx.beginPath();
    canvasCtx.arc(headPos.x, headPos.y, 15, 0, Math.PI * 2);
    canvasCtx.strokeStyle = 'rgba(132,204,22,0.7)';
    canvasCtx.lineWidth = 2.5;
    canvasCtx.stroke();
  }
}

function onPoseResults(results) {
  const now = performance.now();
  fpsFrameCount++;
  if (now - fpsLastTime >= 1000) {
    appState.fps = fpsFrameCount;
    fpsFrameCount = 0;
    fpsLastTime = now;
    document.getElementById('fpsBadge').textContent = appState.fps + ' FPS';
  }

  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;

  if (!results.poseLandmarks) {
    if (settings.showSkeleton) canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (appState.isRunning) {
      appState.stableFrames = Math.max(0, appState.stableFrames - 1);
      if (appState.stableFrames === 0) {
        updateStatusUI('waiting', 'Waiting');
        updateFeedbackBar('Position body in frame', 'neutral');
      }
    }
    document.getElementById('confidenceText').textContent = '0%';
    return;
  }

  const landmarks = results.poseLandmarks;

  const lShoulder = landmarks[POSE_LANDMARKS.leftShoulder];
  const rShoulder = landmarks[POSE_LANDMARKS.rightShoulder];
  const avgConf = lShoulder && rShoulder ? ((lShoulder.visibility + rShoulder.visibility) / 2) : 0;
  appState.confidence = avgConf;
  document.getElementById('confidenceText').textContent = Math.round(avgConf * 100) + '%';

  drawSkeleton(landmarks, canvasEl.width, canvasEl.height);

  if (!appState.isRunning) return;

  const formResult = analyzeForm(landmarks);
  const smoothed = smoothAngle(formResult.avgAngle);

  document.getElementById('elbowAngle').textContent = Math.round(smoothed) + '°';
  updateFormScore(formResult.score);
  updateFeedbackBar(formResult.feedback, formResult.type);

  processPushup(smoothed, formResult);
  updateProgressRing(appState.repProgress);

  const rpm = appState.rpmHistory.length > 0
    ? Math.round(appState.rpmHistory.reduce((a, b) => a + b, 0) / appState.rpmHistory.length)
    : 0;
  document.getElementById('rpmDisplay').textContent = rpm + ' rpm';

  const calories = Math.round(appState.repCount * 0.32);
  document.getElementById('caloriesDisplay').textContent = calories + ' cal';
}

async function initCamera() {
  const noCameraMsg = document.getElementById('noCameraMsg');
  const statusEl = document.getElementById('cameraStatus');
  const statusText = document.getElementById('cameraStatusText');

  try {
    const videoConstraints = settings.cameraDeviceId
      ? { deviceId: { exact: settings.cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

    const constraints = { video: videoConstraints };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = stream;

    await new Promise((resolve) => {
      videoEl.onloadedmetadata = () => resolve();
    });

    noCameraMsg.classList.add('hidden');
    statusEl.classList.add('active');
    statusText.textContent = 'Active';

    populateCameraList(stream);
    initPose();

  } catch (err) {
    console.error('Camera error:', err);
    noCameraMsg.classList.remove('hidden');
    statusText.textContent = 'Denied';
    statusEl.classList.remove('active');
  }
}

async function populateCameraList(activeStream) {
  try {
    const select = document.getElementById('cameraSelect');
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const activeTrack = activeStream.getVideoTracks()[0];
    const activeDeviceId = activeTrack ? activeTrack.getSettings().deviceId : null;

    select.innerHTML = '';
    videoDevices.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || 'Camera ' + (i + 1);
      if (activeDeviceId && device.deviceId === activeDeviceId) opt.selected = true;
      select.appendChild(opt);
    });

    if (activeDeviceId) settings.cameraDeviceId = activeDeviceId;
  } catch {}
}

function initPose() {
  pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    minDetectionConfidence: settings.confidenceThreshold,
    minTrackingConfidence: settings.sensitivity
  });

  pose.onResults(onPoseResults);

  let poseRunning = true;

  async function poseLoop() {
    if (!poseRunning || !pose) return;
    if (videoEl.readyState >= 2 && !videoEl.paused) {
      await pose.send({ image: videoEl });
    }
    requestAnimationFrame(poseLoop);
  }

  mediaCamera = { stop: () => { poseRunning = false; } };
  poseLoop();
  document.getElementById('cameraStatusText').textContent = 'Active';
}

function startSession() {
  appState.isRunning = true;
  appState.sessionStart = Date.now();
  appState.stableFrames = 0;

  sessionTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - appState.sessionStart) / 1000);
    appState.sessionDuration = elapsed;
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('sessionDuration').textContent = m + ':' + s;
  }, 1000);

  const btn = document.getElementById('startStopBtn');
  const icon = document.getElementById('startStopIcon');
  const btnLabel = document.getElementById('startStopLabel');
  btn.classList.add('active');
  btnLabel.textContent = 'Stop';
  icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

  updateStatusUI('ready', 'Ready');
}

function stopSession() {
  appState.isRunning = false;
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;

  saveSession();

  const btn = document.getElementById('startStopBtn');
  const icon = document.getElementById('startStopIcon');
  const btnLabel = document.getElementById('startStopLabel');
  btn.classList.remove('active');
  btnLabel.textContent = 'Start';
  icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';

  updateStatusUI('waiting', 'Waiting');
  updateFeedbackBar('Session ended', 'neutral');
}

function saveSession() {
  if (appState.repCount === 0) return;

  const stats = loadStats();
  stats.totalReps += appState.repCount;
  stats.totalDurationSec += appState.sessionDuration;

  if (appState.repCount > stats.bestSession) {
    stats.bestSession = appState.repCount;
  }

  const avgForm = appState.formScoreHistory.length > 0
    ? Math.round(appState.formScoreHistory.reduce((a, b) => a + b, 0) / appState.formScoreHistory.length)
    : 0;

  const allForms = stats.sessions.map(s => s.avgForm).filter(Boolean);
  allForms.push(avgForm);
  stats.avgFormScore = Math.round(allForms.reduce((a, b) => a + b, 0) / allForms.length);

  const calories = Math.round(appState.repCount * 0.32);
  stats.totalCalories += calories;

  const avgRpm = appState.rpmHistory.length > 0
    ? Math.round(appState.rpmHistory.reduce((a, b) => a + b, 0) / appState.rpmHistory.length)
    : 0;

  stats.sessions.unshift({
    date: new Date().toISOString(),
    reps: appState.repCount,
    durationSec: appState.sessionDuration,
    avgForm,
    calories,
    avgRpm
  });

  if (stats.sessions.length > 50) stats.sessions = stats.sessions.slice(0, 50);

  saveStats(stats);
  renderStats();
}

function resetSession() {
  if (appState.repCount > 0) {
    showConfirm({
      title: 'Reset Session?',
      desc: 'Current progress and rep count will be lost.',
      danger: false,
      onConfirm: () => doReset()
    });
    return;
  }
  doReset();
}

function doReset() {
  if (appState.isRunning) stopSession();

  appState.repCount = 0;
  appState.pushupState = 'UP';
  appState.repProgress = 0;
  appState.formScoreHistory = [];
  appState.rpmHistory = [];
  appState.lastRepTime = null;
  appState.smoothedAngle = 180;
  appState.stableFrames = 0;
  appState.sessionDuration = 0;

  document.getElementById('repCounter').textContent = '0';
  document.getElementById('elbowAngle').textContent = '---°';
  document.getElementById('formScore').textContent = '--';
  document.getElementById('sessionDuration').textContent = '00:00';
  document.getElementById('rpmDisplay').textContent = '0 rpm';
  document.getElementById('caloriesDisplay').textContent = '0 cal';

  updateProgressRing(0);
  updateStatusUI('waiting', 'Waiting');
  updateFeedbackBar('Waiting for detection...', 'neutral');
}

function renderStats() {
  const stats = loadStats();

  document.getElementById('statTotalReps').textContent = stats.totalReps;
  document.getElementById('statBestSession').textContent = stats.bestSession;

  const totalMin = Math.floor(stats.totalDurationSec / 60);
  document.getElementById('statDuration').textContent = totalMin + 'm';
  document.getElementById('statAvgForm').textContent = stats.avgFormScore || '--';
  document.getElementById('statCalories').textContent = stats.totalCalories;

  const avgRpms = stats.sessions.map(s => s.avgRpm).filter(Boolean);
  const overallRpm = avgRpms.length > 0
    ? Math.round(avgRpms.reduce((a, b) => a + b, 0) / avgRpms.length)
    : 0;
  document.getElementById('statAvgRpm').textContent = overallRpm;

  renderSessionHistory(stats.sessions);
}

function renderSessionHistory(sessions) {
  const listEl = document.getElementById('historyList');
  if (!sessions || sessions.length === 0) {
    listEl.innerHTML = `
      <div class="history-empty">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>
        <p>No sessions recorded yet</p>
      </div>`;
    return;
  }

  listEl.innerHTML = sessions.map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const durMin = Math.floor(s.durationSec / 60);
    const durSec = s.durationSec % 60;
    const durStr = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`;
    const scoreClass = s.avgForm >= 80 ? 'good' : s.avgForm >= 55 ? 'fair' : 'poor';
    return `
      <div class="history-item">
        <div class="history-reps">${s.reps}</div>
        <div class="history-details">
          <div class="history-date">${dateStr} · ${timeStr}</div>
          <div class="history-meta">${durStr} · ${s.calories} cal · ${s.avgRpm || 0} rpm</div>
        </div>
        <div class="history-score ${scoreClass}">${s.avgForm}</div>
      </div>`;
  }).join('');
}

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playRepSound() {
  if (!settings.soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {}
}

function applyTheme(theme) {
  settings.theme = theme;
  const body = document.body;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  body.className = '';
  if (theme === 'auto') {
    body.classList.add(prefersDark ? 'theme-dark' : 'theme-light');
  } else {
    body.classList.add('theme-' + theme);
  }
  document.querySelector('meta[name="theme-color"]').setAttribute('content', '#84cc16');
}

function applyMirror(mirrored) {
  const v = document.getElementById('videoElement');
  const c = document.getElementById('overlayCanvas');
  if (mirrored) {
    v.classList.remove('mirror-off');
    c.classList.remove('mirror-off');
  } else {
    v.classList.add('mirror-off');
    c.classList.add('mirror-off');
  }
}

function openSettings() {
  document.getElementById('settingsModal').classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  saveSettings();
}

function initUI() {
  videoEl = document.getElementById('videoElement');
  canvasEl = document.getElementById('overlayCanvas');
  canvasCtx = canvasEl.getContext('2d');

  document.getElementById('startCameraBtn').addEventListener('click', initCamera);

  document.getElementById('startStopBtn').addEventListener('click', () => {
    if (appState.isRunning) stopSession();
    else startSession();
  });

  document.getElementById('resetBtn').addEventListener('click', resetSession);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById(page + 'Page').classList.add('active');
      if (page === 'stats') renderStats();
    });
  });

  document.getElementById('settingsNavBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settingsModal')) closeSettings();
  });

  document.querySelector('#settingsModal .modal').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.getElementById('clearStatsBtn').addEventListener('click', () => {
    showConfirm({
      title: 'Clear All Stats?',
      desc: 'All session history and statistics will be permanently deleted.',
      danger: true,
      onConfirm: () => {
        saveStats(getDefaultStats());
        renderStats();
      }
    });
  });

  document.getElementById('sensitivitySlider').addEventListener('input', (e) => {
    settings.sensitivity = parseFloat(e.target.value);
    document.getElementById('sensitivityVal').textContent = settings.sensitivity.toFixed(2);
  });

  document.getElementById('confidenceSlider').addEventListener('input', (e) => {
    settings.confidenceThreshold = parseFloat(e.target.value);
    document.getElementById('confidenceVal').textContent = settings.confidenceThreshold.toFixed(2);
    if (pose) {
      pose.setOptions({ minDetectionConfidence: settings.confidenceThreshold });
    }
  });

  document.getElementById('skeletonToggle').addEventListener('change', (e) => {
    settings.showSkeleton = e.target.checked;
    if (!settings.showSkeleton) {
      canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    }
  });

  document.getElementById('soundToggle').addEventListener('change', (e) => {
    settings.soundEnabled = e.target.checked;
    if (settings.soundEnabled) getAudioCtx();
  });

  document.getElementById('mirrorToggle').addEventListener('change', (e) => {
    settings.mirrorCamera = e.target.checked;
    applyMirror(settings.mirrorCamera);
  });

  document.getElementById('cameraSelect').addEventListener('change', async (e) => {
    settings.cameraDeviceId = e.target.value;
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    if (mediaCamera) { try { await mediaCamera.stop(); } catch {} }
    if (pose) { try { pose.close(); } catch {} }
    pose = null;
    mediaCamera = null;
    await initCamera();
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTheme(btn.dataset.theme);
    });
  });

  document.getElementById('sensitivitySlider').value = settings.sensitivity;
  document.getElementById('sensitivityVal').textContent = settings.sensitivity.toFixed(2);
  document.getElementById('confidenceSlider').value = settings.confidenceThreshold;
  document.getElementById('confidenceVal').textContent = settings.confidenceThreshold.toFixed(2);
  document.getElementById('skeletonToggle').checked = settings.showSkeleton;
  document.getElementById('soundToggle').checked = settings.soundEnabled;
  document.getElementById('mirrorToggle').checked = settings.mirrorCamera;

  document.querySelectorAll('.theme-btn').forEach(btn => {
    if (btn.dataset.theme === settings.theme) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  applyMirror(settings.mirrorCamera);
  applyTheme(settings.theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme('auto');
  });
}

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('installBtn');
    btn.classList.remove('hidden');
    btn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') btn.classList.add('hidden');
      deferredInstallPrompt = null;
    });
  });

  window.addEventListener('appinstalled', () => {
    document.getElementById('installBtn').classList.add('hidden');
    deferredInstallPrompt = null;
  });
}

function hideSplash() {
  setTimeout(() => {
    const splash = document.getElementById('splashScreen');
    splash.classList.add('hidden');
  }, 1200);
}

async function init() {
  try {
    loadSettings();
    initUI();
    initPWA();
    renderStats();

    const hasPermission = await checkCameraPermission();
    if (hasPermission) {
      initCamera();
    }
  } catch (err) {
    console.error('Init error:', err);
  } finally {
    hideSplash();
  }
}

async function checkCameraPermission() {
  try {
    if (navigator.permissions) {
      const result = await navigator.permissions.query({ name: 'camera' });
      if (result.state === 'granted') return true;
      if (result.state === 'denied') return false;
    }
    return false;
  } catch {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', init);
