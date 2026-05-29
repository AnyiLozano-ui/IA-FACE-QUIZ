import {
    FaceLandmarker,
    HandLandmarker,
    FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/* ===================== ELEMENTOS ===================== */
const video = document.getElementById("webcam");
const canvas = document.getElementById("outputCanvas");
const ctx = canvas.getContext("2d");

const scoreValue = document.querySelector(".score-value");
const iaMessage = document.querySelector(".ia-message");
const questionText = document.getElementById("questionText");
const answerBtns = document.querySelectorAll(".answer-btn");
const instructionDiv = document.querySelector(".instruction");
const questionNumberEl = document.querySelector(".question-number");

let faceLandmarker = null;
let handLandmarker = null;
let lastVideoTime = -1;

/* ===================== CONFIG ===================== */
const TOUCH_HOLD_MS = 420; // antes 850: ahora responde mucho más rápido
const COOLDOWN_MS = 650; // pausa corta después de responder

const THRESH_FACTOR_ENTER = 0.18; // zona de toque más amplia
const THRESH_FACTOR_EXIT = 0.28; // evita que se pierda el toque tan fácil
const SWITCH_IMPROVE_RATIO = 0.60;

// Para pasar de pregunta ahora usamos sonrisa, no giro de cabeza.
const SMILE_HOLD_MS = 1200; // debe sonreír un poco más de 1 segundo para no cambiar tan rápido
const SMILE_SCORE_TH = 0.35; // sensibilidad de sonrisa
const SMILE_RELEASE_TH = 0.20; // debe bajar la sonrisa antes de volver a detectar

const NEUTRAL_REQUIRED_FRAMES = 2;

const TARGET_SMOOTH = 0.55; // menos suavizado para que siga más rápido

let smoothTargets = {
    leftEye: null,
    rightEye: null,
    nose: null,
    mouth: null
};

/* ===================== TRIVIA ===================== */
const QUESTIONS = [{
        q: "¿Qué empresa desarrolló el primer iPhone?",
        options: ["Nokia", "Apple", "Sony", "IBM"],
        answer: 1
    },
    {
        q: "¿Cuál es el país más poblado del mundo actualmente?",
        options: ["India", "Estados Unidos", "Rusia", "Brasil"],
        answer: 0
    },
    {
        q: "¿Qué estructura sirve para repetir instrucciones varias veces?",
        options: ["Bucle", "Imagen", "Carpeta", "Fuente"],
        answer: 0
    },
    {
        q: "¿Qué lenguaje corre directamente en el navegador?",
        options: ["JavaScript", "Excel", "Photoshop", "Word"],
        answer: 0
    },
    {
        q: "¿Qué palabra se usa para tomar decisiones en código?",
        options: ["if", "font", "video", "table"],
        answer: 0
    },
    {
        q: "¿Qué herramienta estás usando aquí para detectar cara y mano?",
        options: ["MediaPipe", "Canva", "Figma", "PowerPoint"],
        answer: 0
    }
];

let idxQ = 0;
let score = 0;
let streak = 0;
let answered = false;
let canAdvance = false;

/* ===================== ESTADO ===================== */
let cooldownUntil = 0;
let lockedRegion = null;
let holdStart = null;
let faceTargets = null;

let smileStartTime = null;
let smileLockedUntilRelease = false;

let awaitingNeutralAfterNext = false;
let neutralFrames = 0;

let cachedFaceLm = null;
let cachedHandLm = null;
let cachedBlendshapes = null;
let frameCount = 0;
const DETECT_EVERY_N_FRAMES = 1; // detectar en cada frame

/* ===================== AUDIO ===================== */
let audioCtx = null;

function beep(freq, durationMs, type = "sine", gain = 0.06) {
    try {
        if (!audioCtx) {
            audioCtx = new(window.AudioContext || window.webkitAudioContext)();
        }
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.value = gain;
        osc.connect(g);
        g.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch {}
}

function soundCorrect() {
    beep(880, 100, "sine", 0.06);
    setTimeout(() => beep(1175, 120, "sine", 0.06), 120);
}

function soundWrong() {
    beep(220, 220, "square", 0.05);
}

function soundNext() {
    beep(440, 90, "triangle", 0.05);
}

/* ===================== UI ===================== */
function showToast(msg) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.style.opacity = "1";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
        toast.style.opacity = "0";
    }, 900);
}

function updateScoreUI() {
    if (scoreValue) {
        scoreValue.textContent = score;
    }
}

function resetOptionStyles() {
    answerBtns.forEach(btn => {
        btn.style.backgroundColor = "";
        btn.style.borderColor = "";
        btn.style.color = "";
    });
}

function styleOption(index, kind) {
    const btn = answerBtns[index];
    if (!btn) return;

    if (kind === "selected") {
        btn.style.backgroundColor = "rgba(124, 58, 237, 0.2)";
        btn.style.borderColor = "#7c3aed";
        btn.style.color = "#fff";
    }

    if (kind === "correct") {
        btn.style.backgroundColor = "#22c55e";
        btn.style.borderColor = "#16a34a";
        btn.style.color = "#fff";
    }

    if (kind === "wrong") {
        btn.style.backgroundColor = "#ef4444";
        btn.style.borderColor = "#dc2626";
        btn.style.color = "#fff";
    }
}

function renderQuestion() {
    const item = QUESTIONS[idxQ % QUESTIONS.length];

    if (questionNumberEl) {
        questionNumberEl.textContent = `PREGUNTA ${idxQ + 1}`;
    }

    if (questionText) {
        questionText.textContent = item.q;
    }

    const regionText = [
        "Toca tu ojo izquierdo",
        "Toca tu ojo derecho",
        "Toca tu nariz",
        "Toca tu boca"
    ];

    answerBtns.forEach((btn, i) => {
        const strongEl = btn.querySelector("strong");
        const spanEl = btn.querySelector("span");

        if (strongEl) strongEl.textContent = `${String.fromCharCode(65 + i)}) ${item.options[i]}`;
        if (spanEl) spanEl.textContent = "";
    });

    resetOptionStyles();

    if (instructionDiv) {
        instructionDiv.innerHTML = `<strong>Primero responde.</strong> Luego sonríe durante un momento para seguir.`;
    }
}


// También permite responder tocando/clickeando los botones.
// Sirve como respaldo si la cámara tarda en detectar el gesto.
answerBtns.forEach((btn, i) => {
    btn.addEventListener("click", () => {
        if (!answered && performance.now() >= cooldownUntil) {
            answer(i);
        }
    });
});

/* ===================== GEOMETRÍA ===================== */
function dist2D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
}

function avgPoints(points) {
    const sum = points.reduce(
        (acc, p) => {
            acc.x += p.x;
            acc.y += p.y;
            return acc;
        }, { x: 0, y: 0 }
    );

    return {
        x: sum.x / points.length,
        y: sum.y / points.length,
        z: 0
    };
}

function lerpPoint(prev, next, alpha = 0.78) {
    if (!prev) return next;
    return {
        x: prev.x * alpha + next.x * (1 - alpha),
        y: prev.y * alpha + next.y * (1 - alpha),
        z: 0
    };
}

function getFaceTargets(faceLm) {
    const leftEyeRaw = avgPoints([
        faceLm[468], faceLm[469], faceLm[470], faceLm[471], faceLm[472]
    ]);

    const rightEyeRaw = avgPoints([
        faceLm[473], faceLm[474], faceLm[475], faceLm[476], faceLm[477]
    ]);

    const noseRaw = avgPoints([
        faceLm[1], faceLm[4]
    ]);

    const mouthRaw = avgPoints([
        faceLm[13], faceLm[14], faceLm[78], faceLm[308]
    ]);

    smoothTargets.leftEye = lerpPoint(smoothTargets.leftEye, leftEyeRaw, TARGET_SMOOTH);
    smoothTargets.rightEye = lerpPoint(smoothTargets.rightEye, rightEyeRaw, TARGET_SMOOTH);
    smoothTargets.nose = lerpPoint(smoothTargets.nose, noseRaw, TARGET_SMOOTH);
    smoothTargets.mouth = lerpPoint(smoothTargets.mouth, mouthRaw, TARGET_SMOOTH);

    const leftCheek = faceLm[234];
    const rightCheek = faceLm[454];
    const faceW = Math.max(0.0001, Math.abs(rightCheek.x - leftCheek.x));

    return {
        leftEye: smoothTargets.leftEye,
        rightEye: smoothTargets.rightEye,
        nose: smoothTargets.nose,
        mouth: smoothTargets.mouth,
        enterThresh: faceW * THRESH_FACTOR_ENTER,
        exitThresh: faceW * THRESH_FACTOR_EXIT
    };
}

function estimateYaw(faceLm) {
    const nose = faceLm[1];
    const left = faceLm[234];
    const right = faceLm[454];
    if (!nose || !left || !right) return 0;

    const midX = (left.x + right.x) / 2;
    const span = Math.max(0.0001, right.x - left.x);
    return (nose.x - midX) / span;
}

function getSmileScore(faceLm, blendshapes) {
    // 1) Primero usamos los blendshapes de MediaPipe porque detectan mejor la sonrisa.
    if (blendshapes?.length) {
        const left = blendshapes.find(c => c.categoryName === "mouthSmileLeft")?.score ?? 0;
        const right = blendshapes.find(c => c.categoryName === "mouthSmileRight")?.score ?? 0;
        return (left + right) / 2;
    }

    // 2) Respaldo geométrico por si el navegador no entrega blendshapes.
    const leftCorner = faceLm[61];
    const rightCorner = faceLm[291];
    const leftCheek = faceLm[234];
    const rightCheek = faceLm[454];
    if (!leftCorner || !rightCorner || !leftCheek || !rightCheek) return 0;

    const mouthWidth = dist2D(leftCorner, rightCorner);
    const faceWidth = Math.max(0.0001, dist2D(leftCheek, rightCheek));
    return Math.max(0, Math.min(1, (mouthWidth / faceWidth - 0.32) / 0.22));
}

/* ===================== OVERLAY ===================== */
function drawTarget(pt, label, active = false, size = 11) {
    if (!pt) return;

    const x = pt.x * canvas.width;
    const y = pt.y * canvas.height;

    ctx.beginPath();
    ctx.arc(x, y, active ? size + 5 : size + 3, 0, Math.PI * 2);
    ctx.fillStyle = active ? "rgba(124,58,237,0.18)" : "rgba(6,182,212,0.10)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, active ? size : size - 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,15,28,0.88)";
    ctx.fill();
    ctx.strokeStyle = active ? "rgba(124,58,237,1)" : "rgba(6,182,212,0.95)";
    ctx.lineWidth = active ? 3 : 2;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5);

    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
}

function drawOverlay(indexTip) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!faceTargets) return;

    drawTarget(faceTargets.leftEye, "A", lockedRegion === "leftEye", 10);
    drawTarget(faceTargets.rightEye, "B", lockedRegion === "rightEye", 10);
    drawTarget(faceTargets.nose, "C", lockedRegion === "nose", 9);
    drawTarget(faceTargets.mouth, "D", lockedRegion === "mouth", 10);

    if (indexTip) {
        const x = indexTip.x * canvas.width;
        const y = indexTip.y * canvas.height;

        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fill();
        ctx.strokeStyle = "rgba(124,58,237,0.92)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
    }
}

/* ===================== GAME ===================== */
const REGION_TO_OPTION = {
    leftEye: 0,
    rightEye: 1,
    nose: 2,
    mouth: 3
};

function answer(opt) {
    const item = QUESTIONS[idxQ % QUESTIONS.length];
    const correct = opt === item.answer;

    answered = true;
    canAdvance = true;

    resetOptionStyles();

    if (correct) {
        styleOption(opt, "correct");
        score += 10;
        streak += 1;

        if (instructionDiv) {
            instructionDiv.innerHTML = `<strong>✅ ¡Correcto!</strong> Ahora sonríe durante un momento para continuar.`;
        }

        soundCorrect();
        showToast("✅ +10");
    } else {
        styleOption(opt, "wrong");
        styleOption(item.answer, "correct");
        streak = 0;

        if (instructionDiv) {
            instructionDiv.innerHTML = `<strong>❌ Incorrecto.</strong> La correcta era: <strong>${item.options[item.answer]}</strong>. Sonríe durante un momento para continuar.`;
        }

        soundWrong();
        showToast("❌");
    }

    cooldownUntil = performance.now() + COOLDOWN_MS;
    updateScoreUI();
}

function nextQuestion() {
    idxQ = (idxQ + 1) % QUESTIONS.length;

    answered = false;
    canAdvance = false;
    lockedRegion = null;
    holdStart = null;

    smileStartTime = null;
    smileLockedUntilRelease = true;

    awaitingNeutralAfterNext = true;
    neutralFrames = 0;

    resetOptionStyles();
    renderQuestion();

    cooldownUntil = performance.now() + 350;

    soundNext();
    showToast("➡️ Siguiente");
}

/* ===================== MODELOS ===================== */
async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
        },
        audio: false
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
        video.onloadedmetadata = resolve;
    });

    await video.play();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
}

async function loadModels() {
    const resolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(resolver, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.35,
        minFacePresenceConfidence: 0.35,
        minTrackingConfidence: 0.35
    });

    handLandmarker = await HandLandmarker.createFromOptions(resolver, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
        },
        runningMode: "VIDEO",
        numHands: 1
    });

    if (iaMessage) iaMessage.textContent = "🧠 IA: lista. Toca cualquier zona marcada del rostro para responder.";
}

/* ===================== LOOP ===================== */
function loop() {
    requestAnimationFrame(loop);

    if (!faceLandmarker || !handLandmarker) return;
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const t = performance.now();

    frameCount++;
    if (frameCount % DETECT_EVERY_N_FRAMES === 0) {
        const faceRes = faceLandmarker.detectForVideo(video, t);
        const handRes = handLandmarker.detectForVideo(video, t);
        cachedFaceLm = faceRes.faceLandmarks[0];
        cachedBlendshapes = faceRes.faceBlendshapes?.[0]?.categories || null;
        cachedHandLm = handRes.landmarks[0];
    }

    const faceLm = cachedFaceLm;
    const handLm = cachedHandLm;
    const indexTip = handLm ? handLm[8] : null;

    const inCooldown = t < cooldownUntil;

    if (!faceLm) {
        faceTargets = null;
        drawOverlay(null);
        if (iaMessage) iaMessage.textContent = "🧠 IA: acércate y mira a la cámara.";
        lockedRegion = null;
        holdStart = null;
        smileStartTime = null;
        smileLockedUntilRelease = false;
        awaitingNeutralAfterNext = false;
        neutralFrames = 0;
        return;
    }

    faceTargets = getFaceTargets(faceLm);
    drawOverlay(indexTip);

    /* ========= BLOQUEO CORTO DE LA NUEVA PREGUNTA ========= */
    if (awaitingNeutralAfterNext) {
        neutralFrames += 1;
        lockedRegion = null;
        holdStart = null;
        resetOptionStyles();

        if (iaMessage) {
            iaMessage.textContent = "🧠 IA: prepara tu siguiente respuesta.";
        }

        if (neutralFrames >= NEUTRAL_REQUIRED_FRAMES) {
            awaitingNeutralAfterNext = false;
            neutralFrames = 0;
        }

        return;
    }

    /* ===== siguiente por sonrisa ===== */
    if (canAdvance && !inCooldown) {
        const smileScore = getSmileScore(faceLm, cachedBlendshapes);

        // Evita que una sonrisa sostenida cambie varias preguntas de una vez.
        // Debe soltar un poco la sonrisa antes de poder detectar otra.
        if (smileLockedUntilRelease) {
            if (smileScore < SMILE_RELEASE_TH) {
                smileLockedUntilRelease = false;
            } else {
                if (iaMessage) iaMessage.textContent = "🧠 IA: relaja la sonrisa y vuelve a sonreír para continuar.";
                return;
            }
        }

        if (smileScore >= SMILE_SCORE_TH) {
            if (!smileStartTime) smileStartTime = t;
            const held = t - smileStartTime;
            const pct = Math.min(100, Math.round((held / SMILE_HOLD_MS) * 100));

            if (iaMessage) iaMessage.textContent = `🧠 IA: sonrisa detectada... ${pct}%`;

            if (held >= SMILE_HOLD_MS) {
                canAdvance = false;
                smileStartTime = null;
                smileLockedUntilRelease = true;
                nextQuestion();
                return;
            }
        } else {
            smileStartTime = null;
            if (iaMessage) iaMessage.textContent = "🧠 IA: sonríe durante un momento para continuar.";
        }

        return;
    } else {
        smileStartTime = null;
    }

    /* ===== respuesta por toque ===== */
    if (!indexTip) {
        if (iaMessage) iaMessage.textContent = "🧠 IA: levanta la mano y toca A, B, C o D.";
        lockedRegion = null;
        holdStart = null;
        if (!answered) resetOptionStyles();
        return;
    }

    if (inCooldown) {
        if (iaMessage) iaMessage.textContent = "🧠 IA: procesando respuesta...";
        lockedRegion = null;
        holdStart = null;
        return;
    }

    const d = {
        leftEye: dist2D(indexTip, faceTargets.leftEye),
        rightEye: dist2D(indexTip, faceTargets.rightEye),
        nose: dist2D(indexTip, faceTargets.nose),
        mouth: dist2D(indexTip, faceTargets.mouth)
    };

    const bestNow = Object.entries(d)
        .map(([r, dist]) => ({ r, dist }))
        .sort((a, b) => a.dist - b.dist)[0];

    if (!lockedRegion) {
        if (bestNow.dist < faceTargets.enterThresh) {
            lockedRegion = bestNow.r;
            holdStart = t;
        } else {
            if (iaMessage) iaMessage.textContent = "🧠 IA: toca una zona fija del rostro para responder";
            if (!answered) resetOptionStyles();
            return;
        }
    } else {
        const distLocked = d[lockedRegion];

        if (distLocked > faceTargets.exitThresh) {
            lockedRegion = null;
            holdStart = null;
            if (!answered) resetOptionStyles();
            if (iaMessage) iaMessage.textContent = "🧠 IA: suelta y vuelve a tocar";
            return;
        }

        if (bestNow.r !== lockedRegion) {
            if (bestNow.dist < distLocked * SWITCH_IMPROVE_RATIO) {
                lockedRegion = bestNow.r;
                holdStart = t;
            }
        }
    }

    const held = holdStart ? (t - holdStart) : 0;
    const opt = REGION_TO_OPTION[lockedRegion];
    const pct = Math.min(100, Math.round((held / TOUCH_HOLD_MS) * 100));

    if (!answered) {
        resetOptionStyles();
        styleOption(opt, "selected");
    }

    if (iaMessage) {
        iaMessage.textContent = `🧠 IA: ${["A", "B", "C", "D"][opt]} ... ${pct}%`;
    }

    if (held >= TOUCH_HOLD_MS && !answered) {
        answer(opt);
        lockedRegion = null;
        holdStart = null;
    }
}

/* ===================== INIT ===================== */
async function init() {
    try {
        updateScoreUI();
        renderQuestion();

        if (iaMessage) iaMessage.textContent = "🧠 IA: activando cámara...";
        await setupCamera();

        if (iaMessage) iaMessage.textContent = "🧠 IA: cargando modelos...";
        await loadModels();

        if (iaMessage) {
            iaMessage.textContent = "🧠 IA: lista. Toca cualquier zona marcada del rostro para responder.";
        }

        loop();
    } catch (err) {
        console.error(err);
        if (iaMessage) {
            iaMessage.textContent = "Error: revisa consola (F12) y permisos de cámara.";
        }
    }
}

init();