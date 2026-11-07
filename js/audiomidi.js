// Gerenciamento completo de Áudio e MIDI (dispositivos, canais, saída, quantidade de amostras e buffer).
import { ctx } from "./audio.js";

const STORAGE_KEY = "labpiano.audiosetup";

const SAMPLE_PRESETS = [
  { samples: 64, label: "64 amostras", tag: "Ultra Rápido", desc: "Baixíssima latência para execução virtuosa e resposta instantânea no controlador." },
  { samples: 128, label: "128 amostras", tag: "Recomendado", desc: "Equilíbrio ideal entre latência mínima e excelente estabilidade para apresentações." },
  { samples: 256, label: "256 amostras", tag: "Equilibrado", desc: "Padrão equilibrado de processamento sem sobrecarregar o processador." },
  { samples: 512, label: "512 amostras", tag: "Alta Estabilidade", desc: "Recomendado para computadores com menor capacidade de processamento." },
  { samples: 1024, label: "1024 amostras", tag: "Máxima Segurança", desc: "Maior tolerância de buffer, eliminando quaisquer estalos ou sobrecargas." }
];

export function mountAudioMidi({
  button,
  dialog,
  midiLearn,
  keyOn,
  keyOff,
  setSustain,
  setMod,
  setBend,
  onProgramChange,
  allNotesOff,
  notify
}) {
  const defaults = {
    midiInputId: "all",
    midiChannel: "all",
    midiOutputId: "none",
    midiThru: false,
    bufferSamples: 128,
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

  let midiAccess = null;
  let audioDevices = [];
  let activityTimer = null;

  const btnLed = button.querySelector(".led");

  // Elementos do diálogo
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
    bufferGrid: dialog.querySelector("#amBufferGrid")
  };

  // Flash do indicador de atividade MIDI
  function flashMidi(msg) {
    button.classList.add("midi-activity");
    if (els.midiLed) els.midiLed.classList.add("active");
    if (els.midiMonitorMsg && msg) els.midiMonitorMsg.textContent = msg;

    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      button.classList.remove("midi-activity");
      if (els.midiLed) els.midiLed.classList.remove("active");
    }, 120);
  }

  // Tocar som de teste musical através da saída do AudioContext
  function playTestChime() {
    if (ctx.state !== "running") ctx.resume();
    const now = ctx.currentTime;
    // Acorde suave de teste (C5, E5, G5) com ataque imediato e cauda natural
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);

      gain.gain.setValueAtTime(0, now + idx * 0.08);
      gain.gain.linearRampToValueAtTime(0.18, now + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.85);

      osc.connect(gain).connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.9);
    });
  }

  // Obter porta de saída MIDI selecionada
  function getSelectedOutput() {
    if (!midiAccess || state.midiOutputId === "none") return null;
    return midiAccess.outputs.get(state.midiOutputId) || null;
  }

  // Mensagem MIDI recebida
  function handleMidiMessage(input, event) {
    const [st, a, b] = event.data;
    const cmd = st & 0xf0;
    const ch = (st & 0x0f) + 1;

    // Filtro de canal se não for Omni
    if (state.midiChannel !== "all" && ch !== +state.midiChannel) {
      return;
    }

    // Filtro de porta de entrada se não for Omni
    if (state.midiInputId !== "all" && input.id !== state.midiInputId) {
      return;
    }

    // MIDI Thru: retransmitir evento cru para a saída configurada
    if (state.midiThru) {
      const outPort = getSelectedOutput();
      if (outPort) {
        try { outPort.send(event.data); } catch { /* erro de envio */ }
      }
    }

    // Formatar mensagem para o monitor em tempo real
    let monitorText = "";
    if (cmd === 0x90 && b > 0) {
      monitorText = `Nota On: #${a} · Vel: ${b} · Canal: ${ch}`;
    } else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) {
      monitorText = `Nota Off: #${a} · Canal: ${ch}`;
    } else if (cmd === 0xb0) {
      monitorText = `CC ${a}: ${b} · Canal: ${ch}`;
    } else if (cmd === 0xe0) {
      const bendVal = (((b << 7) | a) - 8192) / 8192;
      monitorText = `Pitch Bend: ${(bendVal * 100).toFixed(0)}% · Canal: ${ch}`;
    } else if (cmd === 0xc0) {
      monitorText = `Program Change: #${a} · Canal: ${ch}`;
    }

    flashMidi(monitorText);

    // Mapeamento MIDI Learn
    if (cmd === 0xb0 && midiLearn?.handle(a, b)) return;

    // Ações musicais
    if (cmd === 0x90 && b > 0) {
      keyOn(a, b);
    } else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) {
      keyOff(a);
    } else if (cmd === 0xb0 && a === 64) {
      setSustain(b >= 64);
    } else if (cmd === 0xb0 && a === 1) {
      setMod(b / 127);
    } else if (cmd === 0xe0) {
      setBend((((b << 7) | a) - 8192) / 8192);
    } else if (cmd === 0xc0) {
      onProgramChange?.(a % 8);
    }
  }

  // Vincular eventos a uma porta de entrada MIDI
  function bindInput(input) {
    input.onmidimessage = (e) => handleMidiMessage(input, e);
  }

  // Atualizar lista de dispositivos MIDI na interface
  function updateMidiDeviceList() {
    if (!els.midiInSelect || !els.midiOutSelect) return;

    // Entradas
    const currentIn = state.midiInputId;
    let inHtml = `<option value="all">Todos os Dispositivos (Omni)</option>`;
    let hasConnectedIn = false;

    if (midiAccess) {
      midiAccess.inputs.forEach((input) => {
        hasConnectedIn = true;
        const sel = input.id === currentIn ? "selected" : "";
        inHtml += `<option value="${input.id}" ${sel}>${input.name || "Controlador MIDI"} (${input.state})</option>`;
      });
    }

    els.midiInSelect.innerHTML = inHtml;
    button.classList.toggle("has-midi", hasConnectedIn);
    if (btnLed) btnLed.title = hasConnectedIn ? "Controlador MIDI conectado" : "Nenhum controlador MIDI detectado";

    // Saídas
    const currentOut = state.midiOutputId;
    let outHtml = `<option value="none">Desativada (Nenhuma)</option>`;

    if (midiAccess) {
      midiAccess.outputs.forEach((output) => {
        const sel = output.id === currentOut ? "selected" : "";
        outHtml += `<option value="${output.id}" ${sel}>${output.name || "Porta MIDI"} (${output.state})</option>`;
      });
    }

    els.midiOutSelect.innerHTML = outHtml;
  }

  // Atualizar lista de dispositivos de saída de áudio
  async function updateAudioDeviceList() {
    if (!els.audioOutSelect) return;

    if (!navigator.mediaDevices?.enumerateDevices) {
      els.audioOutSelect.innerHTML = `<option value="default">Saída padrão do sistema</option>`;
      if (els.audioStatusMsg) els.audioStatusMsg.textContent = "Navegador gerenciando saída padrão.";
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devices.filter((d) => d.kind === "audiooutput");

      let html = `<option value="default">Saída Padrão do Sistema</option>`;
      let foundCurrent = false;

      audioDevices.forEach((d, i) => {
        const id = d.deviceId;
        const name = d.label || `Interface de Áudio ${i + 1}`;
        const isSel = id === state.audioOutputId;
        if (isSel) foundCurrent = true;
        html += `<option value="${id}" ${isSel ? "selected" : ""}>${name}</option>`;
      });

      if (!foundCurrent && state.audioOutputId !== "default") {
        state.audioOutputId = "default";
        persist();
      }

      els.audioOutSelect.innerHTML = html;

      const canSetSink = typeof ctx.setSinkId === "function";
      if (els.audioStatusMsg) {
        els.audioStatusMsg.textContent = canSetSink
          ? "Roteamento de áudio direto ativado (setSinkId suportado)."
          : "Usando dispositivo padrão do sistema (troque nas configs de som do SO).";
      }
    } catch {
      els.audioOutSelect.innerHTML = `<option value="default">Saída Padrão do Sistema</option>`;
    }
  }

  // Aplicar saída de áudio selecionada
  async function applyAudioOutput(deviceId) {
    state.audioOutputId = deviceId;
    persist();

    if (typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId(deviceId === "default" ? "" : deviceId);
        if (els.audioStatusMsg) els.audioStatusMsg.textContent = "Dispositivo de áudio ativado com sucesso.";
        notify?.(null, null, "Saída de áudio atualizada");
      } catch (err) {
        if (els.audioStatusMsg) els.audioStatusMsg.textContent = "Aviso: " + (err.message || "Não foi possível alternar saída.");
      }
    } else {
      if (els.audioStatusMsg) {
        els.audioStatusMsg.textContent = "Navegador utiliza a saída padrão configurada no seu sistema operacional.";
      }
    }
  }

  // Atualizar métricas técnicas de latência e amostras
  function updateAudioMetrics() {
    const sr = ctx.sampleRate || 44100;
    const baseLat = (ctx.baseLatency || 0) * 1000;
    const outLat = (ctx.outputLatency || 0) * 1000;
    const bufSamples = state.bufferSamples || 128;
    const bufLat = (bufSamples / sr) * 1000;

    if (els.srVal) els.srVal.textContent = `${sr.toLocaleString()} Hz`;
    if (els.latVal) els.latVal.textContent = `~${(baseLat + bufLat).toFixed(1)} ms`;
    if (els.bufferVal) els.bufferVal.textContent = `${bufSamples} amostras (~${bufLat.toFixed(1)} ms)`;
    if (els.engineStateVal) {
      els.engineStateVal.textContent = ctx.state === "running" ? "Ativo (Running)" : "Em Espera (Suspended)";
      els.engineStateVal.className = "engine-state " + (ctx.state === "running" ? "ok" : "warn");
    }

    // Renderizar botões de perfil de buffer
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
  }

  // Inicializar Web MIDI
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      midiAccess = access;
      midiAccess.inputs.forEach(bindInput);

      midiAccess.onstatechange = (e) => {
        if (e.port.type === "input" && e.port.state === "connected") {
          bindInput(e.port);
        }
        updateMidiDeviceList();
        notify?.(null, null, `MIDI ${e.port.type}: ${e.port.name} (${e.port.state})`);
      };

      updateMidiDeviceList();
      if (midiAccess.inputs.size) {
        notify?.(null, null, `MIDI: ${[...midiAccess.inputs.values()].map((i) => i.name).join(", ")}`);
      }
    }).catch(() => {
      button.classList.remove("has-midi");
    });
  } else {
    button.classList.remove("has-midi");
  }

  // Event Listeners da Modal
  button.addEventListener("click", () => {
    if (ctx.state !== "running") ctx.resume();
    updateMidiDeviceList();
    updateAudioDeviceList();
    updateAudioMetrics();

    if (els.midiChannelSelect) els.midiChannelSelect.value = state.midiChannel;
    if (els.midiThruCheck) els.midiThruCheck.checked = state.midiThru;

    dialog.showModal();
  });

  els.closeBtn?.addEventListener("click", () => dialog.close());
  els.doneBtn?.addEventListener("click", () => dialog.close());

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  els.midiInSelect?.addEventListener("change", (e) => {
    state.midiInputId = e.target.value;
    persist();
  });

  els.midiChannelSelect?.addEventListener("change", (e) => {
    state.midiChannel = e.target.value;
    persist();
  });

  els.midiOutSelect?.addEventListener("change", (e) => {
    state.midiOutputId = e.target.value;
    persist();
  });

  els.midiThruCheck?.addEventListener("change", (e) => {
    state.midiThru = e.target.checked;
    persist();
  });

  els.audioOutSelect?.addEventListener("change", (e) => {
    applyAudioOutput(e.target.value);
  });

  els.testAudioBtn?.addEventListener("click", () => {
    playTestChime();
  });

  els.resumeAudioBtn?.addEventListener("click", async () => {
    await ctx.resume();
    updateAudioMetrics();
    notify?.(null, null, "Motor de áudio reiniciado");
  });

  els.panicBtn?.addEventListener("click", () => {
    allNotesOff?.();
    notify?.(null, null, "Pânico: Todas as notas cortadas");
  });

  els.learnBtn?.addEventListener("click", () => {
    dialog.close();
    const mb = document.getElementById("midiBtn");
    if (mb) mb.click();
  });

  els.bufferGrid?.addEventListener("click", (e) => {
    const card = e.target.closest(".buffer-card");
    if (!card) return;
    const samples = +card.dataset.samples;
    if (samples) {
      state.bufferSamples = samples;
      persist();
      updateAudioMetrics();
      notify?.(null, null, `Buffer: ${samples} amostras`);
    }
  });

  // Carregar inicial
  updateAudioMetrics();

  return {
    open: () => button.click(),
    refreshDevices: () => {
      updateMidiDeviceList();
      updateAudioDeviceList();
    }
  };
}
