// Gerenciamento de Áudio e MIDI nativo macOS (CoreAudio HAL + CoreMIDI).
import { nativeBridge } from "./native-bridge.js";

const STORAGE_KEY = "labpiano.audiosetup";

const SAMPLE_PRESETS = [
  { samples: 64, label: "64 amostras", tag: "Ultra Rápido", desc: "Baixíssima latência para execução virtuosa e resposta instantânea no controlador." },
  { samples: 128, label: "128 amostras", tag: "Recomendado", desc: "Equilíbrio ideal entre latência mínima e excelente estabilidade para apresentações." },
  { samples: 256, label: "256 amostras", tag: "Equilibrado", desc: "Padrão equilibrado de processamento sem sobrecarregar o processador." },
  { samples: 512, label: "512 amostras", tag: "Alta Estabilidade", desc: "Recomendado para computadores com menor capacidade de processamento." },
  { samples: 1024, label: "1024 amostras", tag: "Máxima Segurança", desc: "Maior tolerância de buffer, eliminando quaisquer estalos ou sobrecargas." }
];

const PERF_PRESETS = [
  { mode: "live", label: "Palco / MacBook", tag: "Recomendado (Leve)", desc: "Polifonia otimizada para tocar ao vivo com máxima estabilidade térmica." },
  { mode: "studio", label: "Estúdio (Fidelidade)", tag: "Mais CPU", desc: "Polifonia expandida e processamento completo para estúdio." }
];

export function mountAudioMidi({
  button,
  dialog,
  midiLearn,
  keyOn,
  keyOff,
  onNativeNoteVisual,
  onNativeSustainVisual,
  setSustain,
  setMod,
  setBend,
  onProgramChange,
  allNotesOff,
  notify,
  onPerfModeChange
}) {
  const defaults = {
    midiInputId: "all",
    midiChannel: "all",
    midiOutputId: "none",
    midiThru: false,
    bufferSamples: 256,
    perfMode: "live",
    audioOutputId: "default"
  };

  let state = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state = { ...state, ...saved };
  } catch {
    // fallback para padrão
  }

  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // sem storage
    }
  };

  let activityTimer = null;
  let nativeAudioState = {
    sampleRate: 44100,
    bufferSamples: Number(state.bufferSamples) || 256,
    latencyMs: ((Number(state.bufferSamples) || 256) / 44100) * 1000,
    running: nativeBridge.active,
    error: "",
    audioDevices: [],
    midiInputs: [],
    midiOutputs: []
  };

  const btnLed = button.querySelector(".led");

  const els = {
    closeBtn: dialog.querySelector("#amCloseBtn"),
    doneBtn: dialog.querySelector("#amDoneBtn"),
    panicBtn: dialog.querySelector("#amPanicBtn"),
    learnBtn: dialog.querySelector("#amLearnBtn"),
    testAudioBtn: dialog.querySelector("#amTestAudioBtn"),
    resumeAudioBtn: dialog.querySelector("#amResumeAudioBtn"),
    midiInSelect: dialog.querySelector("#amMidiIn"),
    midiChannelSelect: dialog.querySelector("#amMidiChannel"),
    midiOutSelect: dialog.querySelector("#amMidiOut"),
    midiThruCheck: dialog.querySelector("#amMidiThru"),
    audioOutSelect: dialog.querySelector("#amAudioOut"),
    audioStatusMsg: dialog.querySelector("#amAudioStatusMsg"),
    midiMonitorMsg: dialog.querySelector("#amMidiMonitorMsg"),
    midiLed: dialog.querySelector("#amMidiActLed"),
    srVal: dialog.querySelector("#amSrVal"),
    latVal: dialog.querySelector("#amLatVal"),
    bufferVal: dialog.querySelector("#amBufferVal"),
    engineStateVal: dialog.querySelector("#amEngineStateVal"),
    bufferGrid: dialog.querySelector("#amBufferGrid"),
    perfGrid: dialog.querySelector("#amPerfGrid")
  };

  function flashMidi(msg) {
    if (!button.classList.contains("midi-activity")) {
      button.classList.add("midi-activity");
    }
    if (dialog.open) {
      if (els.midiLed && !els.midiLed.classList.contains("active")) els.midiLed.classList.add("active");
      if (els.midiMonitorMsg && msg) els.midiMonitorMsg.textContent = msg;
    }

    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      button.classList.remove("midi-activity");
      if (els.midiLed) els.midiLed.classList.remove("active");
    }, 120);
  }

  function processMidiBytes(st, a, b, handledNatively = false) {
    const cmd = st & 0xf0;

    if (dialog.open) {
      const ch = (st & 0x0f) + 1;
      let monitorText = "";
      if (cmd === 0x90 && b > 0) monitorText = `Nota On: #${a} · Vel: ${b} · Canal: ${ch}`;
      else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) monitorText = `Nota Off: #${a} · Canal: ${ch}`;
      else if (cmd === 0xb0) monitorText = `CC ${a}: ${b} · Canal: ${ch}`;
      else if (cmd === 0xe0) monitorText = `Pitch Bend: ${((((b << 7) | a) - 8192) / 8192 * 100).toFixed(0)}% · Canal: ${ch}`;
      else if (cmd === 0xc0) monitorText = `Program Change: #${a} · Canal: ${ch}`;
      flashMidi(monitorText);
    } else {
      flashMidi("");
    }

    if (cmd === 0xb0 && midiLearn?.handle(a, b)) return;

    if (handledNatively) {
      if (cmd === 0x90 && b > 0) onNativeNoteVisual?.(a, b);
      else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) onNativeNoteVisual?.(a, 0);
      else if (cmd === 0xb0 && a === 64) onNativeSustainVisual?.(b >= 64);
      else if (cmd === 0xc0) onProgramChange?.(a % 8);
      return;
    }

    if (cmd === 0x90 && b > 0) keyOn(a, b);
    else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) keyOff(a);
    else if (cmd === 0xb0 && a === 64) setSustain(b >= 64);
    else if (cmd === 0xb0 && a === 1) setMod(b / 127);
    else if (cmd === 0xe0) setBend((((b << 7) | a) - 8192) / 8192);
    else if (cmd === 0xc0) onProgramChange?.(a % 8);
  }

  function syncNativeMidiConfig() {
    nativeBridge.send("setMidiConfig", {
      inputId: state.midiInputId,
      channel: state.midiChannel,
      outputId: state.midiOutputId,
      thru: Boolean(state.midiThru)
    });
  }

  function updateMidiDeviceList() {
    if (!els.midiInSelect || !els.midiOutSelect) return;

    const currentIn = state.midiInputId;
    let inHtml = `<option value="all">Todos os Dispositivos (Omni)</option>`;
    let hasConnectedIn = false;

    for (const input of nativeAudioState.midiInputs || []) {
      hasConnectedIn = true;
      const sel = input.id === currentIn ? "selected" : "";
      inHtml += `<option value="${input.id}" ${sel}>${input.name || "CoreMIDI Input"} (CoreMIDI)</option>`;
    }
    els.midiInSelect.innerHTML = inHtml;
    button.classList.toggle("has-midi", hasConnectedIn);
    if (btnLed) btnLed.title = hasConnectedIn ? "CoreMIDI conectado" : "Nenhum controlador CoreMIDI detectado";

    const currentOut = state.midiOutputId;
    let outHtml = `<option value="none">Desativada (Nenhuma)</option>`;
    for (const output of nativeAudioState.midiOutputs || []) {
      const sel = output.id === currentOut ? "selected" : "";
      outHtml += `<option value="${output.id}" ${sel}>${output.name || "CoreMIDI Output"}</option>`;
    }
    els.midiOutSelect.innerHTML = outHtml;
  }

  function updateAudioDeviceList() {
    if (!els.audioOutSelect) return;

    let html = `<option value="default">Saída Padrão do macOS (CoreAudio)</option>`;
    let foundCurrent = false;
    for (const d of nativeAudioState.audioDevices || []) {
      const isSel = d.id === state.audioOutputId;
      if (isSel) foundCurrent = true;
      html += `<option value="${d.id}" ${isSel ? "selected" : ""}>${d.name}</option>`;
    }
    if (!foundCurrent && state.audioOutputId !== "default") {
      state.audioOutputId = "default";
      persist();
    }
    els.audioOutSelect.innerHTML = html;
    if (els.audioStatusMsg) {
      if (!nativeBridge.active) {
        els.audioStatusMsg.textContent = "Áudio Web removido — compile e abra via Xcode (macos/WorkestraPiano.xcodeproj) para áudio nativo.";
      } else if (nativeAudioState.running === false) {
        els.audioStatusMsg.textContent = nativeAudioState.error
          ? `Erro CoreAudio: ${nativeAudioState.error}`
          : "CoreAudio parado — clique em Reiniciar CoreAudio ou selecione outra saída.";
      } else {
        els.audioStatusMsg.textContent = "CoreAudio HAL nativo ativo — roteamento direto de hardware macOS.";
      }
    }
  }

  async function applyAudioOutput(deviceId) {
    state.audioOutputId = deviceId;
    persist();
    if (!nativeBridge.active) return;
    try {
      const next = await nativeBridge.request("setAudioDevice", { deviceId });
      if (next) nativeAudioState = { ...nativeAudioState, ...next };
      updateAudioMetrics();
      if (els.audioStatusMsg) els.audioStatusMsg.textContent = "Saída CoreAudio ativada imediatamente.";
      notify?.(null, null, "CoreAudio atualizado");
    } catch (err) {
      if (els.audioStatusMsg) els.audioStatusMsg.textContent = "Aviso CoreAudio: " + (err.message || "Falha ao alternar saída.");
    }
  }

  function updateAudioMetrics() {
    const sr = nativeAudioState.sampleRate || 44100;
    const bufSamples = Number(nativeAudioState.bufferSamples) || Number(state.bufferSamples) || 256;
    const bufLat = (bufSamples / sr) * 1000;
    const totalLat = nativeAudioState.latencyMs || bufLat;

    if (els.srVal) els.srVal.textContent = `${sr.toLocaleString()} Hz`;
    if (els.latVal) els.latVal.textContent = `~${totalLat.toFixed(1)} ms`;
    if (els.bufferVal) els.bufferVal.textContent = `${bufSamples} amostras (~${bufLat.toFixed(1)} ms)`;
    if (els.resumeAudioBtn) els.resumeAudioBtn.textContent = "Reiniciar CoreAudio";

    if (els.engineStateVal) {
      if (nativeBridge.active) {
        if (nativeAudioState.running) {
          els.engineStateVal.textContent = "CoreAudio Nativo + libc++ Ativo";
          els.engineStateVal.className = "engine-state ok";
        } else {
          els.engineStateVal.textContent = nativeAudioState.error
            ? `CoreAudio parado (${nativeAudioState.error})`
            : "CoreAudio parado";
          els.engineStateVal.className = "engine-state warn";
        }
      } else {
        els.engineStateVal.textContent = "Somente app macOS (CoreAudio)";
        els.engineStateVal.className = "engine-state warn";
      }
    }

    if (els.bufferGrid) {
      els.bufferGrid.innerHTML = SAMPLE_PRESETS.map((p) => {
        const isSel = p.samples === state.bufferSamples;
        const estLat = ((p.samples / sr) * 1000).toFixed(1);
        return `
          <button type="button" class="buffer-card ${isSel ? "active" : ""}" data-samples="${p.samples}">
            <div class="buf-head">
              <span class="buf-samples">${p.samples} amostras</span>
              <span class="buf-lat">~${estLat} ms</span>
            </div>
            <div class="buf-tag">${p.tag}</div>
            <p class="buf-desc">${p.desc}</p>
          </button>
        `;
      }).join("");
    }

    if (els.perfGrid) {
      const curMode = state.perfMode === "studio" ? "studio" : "live";
      els.perfGrid.innerHTML = PERF_PRESETS.map((p) => {
        const isSel = p.mode === curMode;
        return `
          <button type="button" class="buffer-card ${isSel ? "active" : ""}" data-perf="${p.mode}">
            <div class="buf-head">
              <span class="buf-samples">${p.label}</span>
              <span class="buf-lat">${isSel ? "Ativo" : ""}</span>
            </div>
            <div class="buf-tag">${p.tag}</div>
            <p class="buf-desc">${p.desc}</p>
          </button>
        `;
      }).join("");
    }
  }

  async function refreshNativeAudioMidiState() {
    if (!nativeBridge.active) {
      updateMidiDeviceList();
      updateAudioDeviceList();
      updateAudioMetrics();
      return;
    }
    try {
      const info = await nativeBridge.request("getAudioMidiState", {});
      if (info) {
        nativeAudioState = { ...nativeAudioState, ...info };
        updateMidiDeviceList();
        updateAudioDeviceList();
        updateAudioMetrics();
        if (info.running === false) {
          notify?.("Aviso CoreAudio", info.error || "Abra Áudio/MIDI → Reiniciar CoreAudio", null);
        }
      }
    } catch (err) {
      console.warn("Erro ao consultar estado CoreAudio/CoreMIDI:", err);
    }
  }

  if (nativeBridge.active) {
    syncNativeMidiConfig();
    nativeBridge.request("setBufferSamples", { samples: Number(state.bufferSamples) || 256 }).catch(() => {});
    if (state.audioOutputId && state.audioOutputId !== "default") {
      nativeBridge.request("setAudioDevice", { deviceId: state.audioOutputId }).catch(() => {});
    }
    refreshNativeAudioMidiState();

    nativeBridge.onEvent("midiEvent", (ev) => {
      if (!ev) return;
      processMidiBytes(ev.status, ev.data1, ev.data2, Boolean(ev.handledNatively));
    });
    nativeBridge.onEvent("midiDevices", (ev) => {
      if (!ev) return;
      nativeAudioState.midiInputs = ev.inputs || [];
      nativeAudioState.midiOutputs = ev.outputs || [];
      updateMidiDeviceList();
      if (ev.notice) notify?.(null, null, ev.notice);
    });
    nativeBridge.onEvent("audioState", (ev) => {
      if (!ev) return;
      nativeAudioState = { ...nativeAudioState, ...ev };
      updateAudioDeviceList();
      updateAudioMetrics();
      if (ev.running === false) {
        notify?.("Aviso CoreAudio", ev.error || "Abra Áudio/MIDI → Reiniciar CoreAudio", null);
      }
    });
  } else {
    button.classList.remove("has-midi");
  }

  button.addEventListener("click", () => {
    refreshNativeAudioMidiState();
    if (els.midiChannelSelect) els.midiChannelSelect.value = state.midiChannel;
    if (els.midiThruCheck) els.midiThruCheck.checked = state.midiThru;
    dialog.showModal();
  });

  els.closeBtn?.addEventListener("click", () => dialog.close());
  els.doneBtn?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  els.midiInSelect?.addEventListener("change", (e) => { state.midiInputId = e.target.value; persist(); syncNativeMidiConfig(); });
  els.midiChannelSelect?.addEventListener("change", (e) => { state.midiChannel = e.target.value; persist(); syncNativeMidiConfig(); });
  els.midiOutSelect?.addEventListener("change", (e) => { state.midiOutputId = e.target.value; persist(); syncNativeMidiConfig(); });
  els.midiThruCheck?.addEventListener("change", (e) => { state.midiThru = e.target.checked; persist(); syncNativeMidiConfig(); });
  els.audioOutSelect?.addEventListener("change", (e) => { applyAudioOutput(e.target.value); });

  els.testAudioBtn?.addEventListener("click", () => {
    if (!nativeBridge.active) {
      if (els.audioStatusMsg) {
        els.audioStatusMsg.textContent = "Sem áudio no navegador — compile e abra o app macOS no Xcode.";
      }
      notify?.("Sem áudio no navegador", "Áudio nativo só no app Mac (Xcode)", "Áudio Web removido");
      return;
    }
    nativeBridge.send("testChime", {});
    notify?.(null, "Som de teste CoreAudio enviado", null);
  });

  els.resumeAudioBtn?.addEventListener("click", async () => {
    if (!nativeBridge.active) {
      notify?.("Sem áudio no navegador", "Compile e abra no Xcode (WorkestraPiano)", "Áudio Web removido");
      return;
    }
    try {
      const info = await nativeBridge.request("restartAudioEngine", {});
      if (info) nativeAudioState = { ...nativeAudioState, ...info };
      updateAudioDeviceList();
      updateAudioMetrics();
      if (info?.running === false) {
        notify?.("Aviso CoreAudio", info.error || "Falha ao reiniciar CoreAudio", null);
      } else {
        notify?.(null, null, "Motor CoreAudio reiniciado");
      }
    } catch (err) {
      notify?.(null, null, String(err.message || err));
    }
  });

  els.panicBtn?.addEventListener("click", () => {
    allNotesOff?.();
    notify?.(null, null, "Pânico: Todas as notas cortadas");
  });

  els.learnBtn?.addEventListener("click", () => {
    dialog.close();
    document.getElementById("midiBtn")?.click();
  });

  els.bufferGrid?.addEventListener("click", async (e) => {
    const card = e.target.closest(".buffer-card");
    if (!card) return;
    const samples = +card.dataset.samples;
    if (!samples) return;
    state.bufferSamples = samples;
    persist();
    if (!nativeBridge.active) { updateAudioMetrics(); return; }
    try {
      const info = await nativeBridge.request("setBufferSamples", { samples });
      if (info) nativeAudioState = { ...nativeAudioState, ...info };
      updateAudioMetrics();
      if (els.audioStatusMsg) {
        els.audioStatusMsg.textContent = `CoreAudio configurado para ${samples} amostras (~${nativeAudioState.latencyMs?.toFixed(1) || ""} ms).`;
      }
      notify?.(null, `CoreAudio: ${samples} amostras`, "Aplicado no hardware");
    } catch (err) {
      notify?.(null, "Erro CoreAudio", String(err.message || err));
    }
  });

  els.perfGrid?.addEventListener("click", (e) => {
    const card = e.target.closest(".buffer-card[data-perf]");
    if (!card) return;
    const mode = card.dataset.perf === "studio" ? "studio" : "live";
    state.perfMode = mode;
    persist();
    onPerfModeChange?.(mode);
    updateAudioMetrics();
    const label = mode === "live" ? "Palco / MacBook" : "Estúdio";
    notify?.(null, `Perfil: ${label}`, "Aplicado em tempo real");
  });

  updateAudioMetrics();

  return {
    open: () => button.click(),
    refreshDevices: refreshNativeAudioMidiState,
  };
}
