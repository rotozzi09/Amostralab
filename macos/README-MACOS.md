# WorkestraPiano — Versão Nativa macOS (CoreAudio + CoreMIDI + WebKit + Foundation + libc++)

Esta pasta contém o projeto Xcode nativo do **WorkestraPiano** sem dependências externas (nenhum pacote Homebrew ou biblioteca de terceiros necessária).

## Arquitetura Nativa
- **CoreAudio / AudioToolbox / AVFoundation**:
  - `AVAudioEngine` rodando diretamente no hardware CoreAudio HAL (seleção de interface de áudio + buffer de `64` a `1024` amostras).
  - 5 instâncias de `AVAudioUnitSampler` (`Piano A`, `Piano B`, `Strings A`, `Strings B`, `Synth Sample`) carregando arquivos `.sf2` direto do SSD.
  - Efeitos nativos (`AVAudioUnitEQ`, `AVAudioUnitDelay`, `AVAudioUnitReverb`).
- **libc++ (C++17 em `NativeDSP.mm`)**:
  - Motor subtrativo `Synth A/B` com osciladores PolyBLEP (`Sawtooth`, `Square PWM`, `Triangle`, `Supersaw`), filtro ladder 24 dB (TPT SVF) e envelope ADSR sem alocações na thread de áudio.
  - Motor `Organ` (`B3`, `Vox`, `Farfisa`) com 9 drawbars, foldback, percussão, clique, vibrato scanner, overdrive e efeito Rotary Leslie.
- **CoreMIDI (`AudioMidiEngine.swift`)**:
  - Leitura direta de controladores MIDI USB/Bluetooth via `MIDIClientCreateWithBlock` / `MIDIInputPortCreateWithBlock` com hot-plug e MIDI Thru em tempo real (sem latência de navegador).
- **WebKit + Foundation (`AppDelegate.swift`)**:
  - `WKWebView` servindo a interface diretamente por esquema nativo `app://`.
  - Biblioteca local automática em `~/Music/WorkestraPiano/Sounds` (`Piano`, `Strings`, `Synth`) e cache em disco para arquivos `.npno`/`.svz`/`.wav` já convertidos em `~/Library/Application Support/WorkestraPiano/ConvertedCache`.

## Como compilar no MacBook (Xcode)

1. Copie/baixe a pasta completa do projeto para o seu Mac.
2. Abra o arquivo:
   ```
   macos/WorkestraPiano.xcodeproj
   ```
   no Xcode (ou pelo Terminal: `open macos/WorkestraPiano.xcodeproj`).
3. No topo do Xcode, selecione o esquema **WorkestraPiano** e **My Mac**.
4. Pressione **Cmd + R** para compilar e executar imediatamente (ou **Product → Archive** / **Product → Build For → Running** em Release para gerar o `WorkestraPiano.app`).

> Nota: o aplicativo opera 100% no motor nativo macOS (CoreAudio + CoreMIDI + AVFoundation + libc++), sem motores Web Audio ou WebAssembly. Na fase de build **"Sync WebUI Assets"**, o Xcode copia apenas a interface (`index.html`, `css/` e `js/`) para dentro do bundle `.app`.
