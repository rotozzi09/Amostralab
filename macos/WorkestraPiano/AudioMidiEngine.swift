import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMIDI

final class AudioMidiEngine {
    typealias EventEmitter = (_ type: String, _ payload: [String: Any]) -> Void

    private let emitEvent: EventEmitter
    private let audioQueue = DispatchQueue(label: "com.amostralab.workestrapiano.audio", qos: .userInteractive)
    private let midiQueue = DispatchQueue(label: "com.amostralab.workestrapiano.midi", qos: .userInteractive)
    private let cpuQueue = DispatchQueue(label: "com.amostralab.workestrapiano.cpu", qos: .utility)
    private var cpuTimer: DispatchSourceTimer?
    private var smoothedCpuLoad: Double = 0.0
    private var lastCpuSentPercent: Int = -1

    private var engine = AVAudioEngine()
    private var dsp: WorkestraNativeDSP!
    private var sourceNode: AVAudioSourceNode?
    private var fixedNodes: [AVAudioNode] = []
    private var meterTapInstalled = false
    private var isRebuildingGraph = false
    private var graphTier: Int = 0
    private var masterVolume: Float = 0.768
    private var configObserver: NSObjectProtocol?
    private var defaultDeviceListenerBlock: AudioObjectPropertyListenerBlock?
    private var pendingReconfigWorkItem: DispatchWorkItem?
    private var lastRebuildAt: CFAbsoluteTime = 0
    private let stateLock = NSLock()

    // 5 Sampler instances (AudioToolbox AUv2 Apple Sampler natively powered by CoreAudio)
    private let pianoSamplerA = AVAudioUnitSampler()
    private let pianoSamplerB = AVAudioUnitSampler()
    private let stringsSamplerA = AVAudioUnitSampler()
    private let stringsSamplerB = AVAudioUnitSampler()
    private let synthSamplerA = AVAudioUnitSampler()

    // Channel mixers & Filters
    private let pianoGainA = AVAudioMixerNode()
    private let pianoGainB = AVAudioMixerNode()
    private let pianoSectionMixer = AVAudioMixerNode()
    private let pianoTimbreEQ = AVAudioUnitEQ(numberOfBands: 1)

    private let stringsGainA = AVAudioMixerNode()
    private let stringsGainB = AVAudioMixerNode()
    private let stringsFilterA = AVAudioUnitEQ(numberOfBands: 1)
    private let stringsFilterB = AVAudioUnitEQ(numberOfBands: 1)
    private let stringsSectionMixer = AVAudioMixerNode()

    private let synthSampleGain = AVAudioMixerNode()

    // Global FX bus (EQ -> Delay -> Reverb -> MainMixer -> Output)
    private let preFxBus = AVAudioMixerNode()
    private let masterEQ = AVAudioUnitEQ(numberOfBands: 3)
    private let delayUnit = AVAudioUnitDelay()
    private let reverbUnit = AVAudioUnitReverb()

    private var sampleRate: Double = 44100.0
    private var stereoFormat: AVAudioFormat!
    private var currentDeviceUID: String = "default"
    private var targetBufferFrames: Int = 256
    private var lastMeterSent: CFAbsoluteTime = 0
    private var lastMeterWasZero: Bool = true
    private var lastVisualMidiCC: CFAbsoluteTime = 0

    // Sample Pads & Custom Pad Timbre (Workstation mode - 100% CoreAudio/AVFoundation)
    private let padMixer = AVAudioMixerNode()
    private let padPlayers: [AVAudioPlayerNode] = (0..<16).map { _ in AVAudioPlayerNode() }
    private let padPreviewPlayer = AVAudioPlayerNode()
    private var padBuffers: [Int: AVAudioPCMBuffer] = [:]
    private var padGeneration: [Int: Int] = [:]

    private let padTimbreSampler = AVAudioUnitSampler()
    private let padTimbreMixer = AVAudioMixerNode()
    private enum PadTimbreKind { case nativeDSP, samplerSF2, audioLoop }
    private var padTimbreKind: PadTimbreKind = .nativeDSP
    private var activePadSamplerNote: UInt8?
    private var contPadPlaying: Bool = false
    private var contPadKey: Int = 0
    private var contPadOctave: Int = 0
    private var lastAudioError: String?
    private var lastMidiError: String?

    // Loaded state tracking
    private struct LoadedSamplerState {
        var url: URL?
        var bank: Int = 0
        var preset: Int = 0
        var active: Bool = true
        var gain: Float = 1.0
    }
    private var samplerStates: [String: LoadedSamplerState] = [
        "piano:A": LoadedSamplerState(),
        "piano:B": LoadedSamplerState(),
        "strings:A": LoadedSamplerState(),
        "strings:B": LoadedSamplerState(),
        "synth:A": LoadedSamplerState()
    ]

    // Routing state for direct low-latency CoreMIDI processing
    private struct LayerRouting {
        var on: Bool
        var level: Float = 0.8
        var octave: Int = 0
        var zone: String = "all"
    }
    private var sectionOn: [String: Bool] = ["organ": false, "piano": true, "synth": false, "strings": false]
    private var sectionOctave: [String: Int] = ["organ": 0, "piano": 0, "synth": 0, "strings": 0]
    private var sectionLevels: [String: Float] = ["organ": 0.85, "piano": 0.85, "synth": 0.85, "strings": 0.85]
    private var layerRouting: [String: [String: LayerRouting]] = [
        "organ": ["A": LayerRouting(on: true), "B": LayerRouting(on: false)],
        "piano": ["A": LayerRouting(on: true), "B": LayerRouting(on: false)],
        "synth": ["A": LayerRouting(on: true), "B": LayerRouting(on: false)],
        "strings": ["A": LayerRouting(on: true), "B": LayerRouting(on: false)]
    ]
    private var transpose: Int = 0
    private var splitNote: Int = 60
    private var velCurve: Double = 1.0
    private var directMidi: Bool = true
    private var synthIsSample: Bool = false
    private var heldKeys: [Int: [(section: String, layer: String, note: Int)]] = [:]

    // CoreMIDI
    private var midiClient = MIDIClientRef()
    private var midiInputPort = MIDIPortRef()
    private var midiOutputPort = MIDIPortRef()
    private var connectedSources: [MIDIEndpointRef: MIDIUniqueID] = [:]
    private var midiInputFilter: String = "all"
    private var enabledMidiInputIDs: Set<String>? = nil // nil = all devices
    private var midiChannelFilter: String = "all"
    private var midiOutputId: String = "none"
    private var midiThru: Bool = false
    private var midiPacketsReceived: Int = 0
    private var midiConnectedCount: Int = 0
    private var midiProtocolMode: String = "uninitialized"

    // Foundation directories
    let soundsRootURL: URL
    let convertedCacheURL: URL

    init(emitEvent: @escaping EventEmitter) {
        self.emitEvent = emitEvent

        let fm = FileManager.default
        let musicURL = fm.urls(for: .musicDirectory, in: .userDomainMask).first
            ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Music")
        self.soundsRootURL = musicURL.appendingPathComponent("WorkestraPiano/Sounds", isDirectory: true)

        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        self.convertedCacheURL = appSupport.appendingPathComponent("WorkestraPiano/ConvertedCache", isDirectory: true)

        try? fm.createDirectory(at: soundsRootURL, withIntermediateDirectories: true)
        try? fm.createDirectory(at: soundsRootURL.appendingPathComponent("Piano", isDirectory: true), withIntermediateDirectories: true)
        try? fm.createDirectory(at: soundsRootURL.appendingPathComponent("Strings", isDirectory: true), withIntermediateDirectories: true)
        try? fm.createDirectory(at: soundsRootURL.appendingPathComponent("Synth", isDirectory: true), withIntermediateDirectories: true)
        try? fm.createDirectory(at: convertedCacheURL, withIntermediateDirectories: true)

        setupAudioGraph()
        setupCoreMIDI()
        setupHardwareListeners()
        startCpuMonitor()
    }

    deinit {
        cpuTimer?.cancel()
        cpuTimer = nil
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        if let block = defaultDeviceListenerBlock {
            var addr = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, audioQueue, block)
        }
        if meterTapInstalled {
            preFxBus.removeTap(onBus: 0)
            meterTapInstalled = false
        }
        engine.stop()
        if midiClient != 0 {
            MIDIClientDispose(midiClient)
        }
    }

    // MARK: - CoreAudio / AVAudioEngine Setup

    private func configureMaxFrames(_ unit: AVAudioUnit, frames: UInt32 = 4096) {
        var maxFrames = frames
        AudioUnitSetProperty(
            unit.audioUnit,
            kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global,
            0,
            &maxFrames,
            UInt32(MemoryLayout<UInt32>.size)
        )
    }

    private func setupAudioGraph() {
        let devID = WorkestraNativeDSP.defaultOutputDeviceID()
        let initialSR = WorkestraNativeDSP.sampleRate(forDevice: devID)
        self.sampleRate = initialSR > 0 ? initialSR : 44100.0
        self.dsp = WorkestraNativeDSP(sampleRate: self.sampleRate)

        var nodes: [AVAudioNode] = [
            pianoSamplerA, pianoSamplerB, pianoGainA, pianoGainB, pianoSectionMixer, pianoTimbreEQ,
            stringsSamplerA, stringsSamplerB, stringsGainA, stringsGainB, stringsFilterA, stringsFilterB, stringsSectionMixer,
            synthSamplerA, synthSampleGain,
            padMixer, padPreviewPlayer,
            padTimbreSampler, padTimbreMixer,
            preFxBus, masterEQ, delayUnit, reverbUnit
        ]
        nodes.append(contentsOf: padPlayers)
        self.fixedNodes = nodes
        for n in nodes {
            engine.attach(n)
        }

        configureEQDefaults()

        delayUnit.wetDryMix = 0
        delayUnit.delayTime = 0.4
        delayUnit.feedback = 35
        delayUnit.lowPassCutoff = 3800
        delayUnit.bypass = true

        reverbUnit.loadFactoryPreset(.mediumHall)
        reverbUnit.wetDryMix = 0
        reverbUnit.bypass = true

        engine.mainMixerNode.outputVolume = masterVolume
        pianoSectionMixer.outputVolume = 1.0
        stringsSectionMixer.outputVolume = 1.0
        preFxBus.outputVolume = 1.0

        connectAndStartAudioGraph(tier: 0)
    }

    private func registerEngineConfigObserver() {
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            guard let self = self else { return }
            self.scheduleGraphRebuild(reason: "AVAudioEngineConfigurationChange")
        }
    }

    private func attachIfNeeded(_ node: AVAudioNode) {
        if node.engine !== engine {
            engine.attach(node)
        }
    }

    private func detachAllFromCurrentEngine() {
        for n in fixedNodes where n.engine === engine {
            engine.disconnectNodeOutput(n)
            engine.detach(n)
        }
        if let sn = sourceNode, sn.engine === engine {
            engine.disconnectNodeOutput(sn)
            engine.detach(sn)
        }
        engine.disconnectNodeOutput(engine.mainMixerNode)
    }

    @discardableResult
    private func connectAndStartAudioGraph(tier: Int = 0) -> Bool {
        isRebuildingGraph = true
        lastRebuildAt = CFAbsoluteTimeGetCurrent()
        defer {
            isRebuildingGraph = false
            lastRebuildAt = CFAbsoluteTimeGetCurrent()
        }

        if meterTapInstalled {
            preFxBus.removeTap(onBus: 0)
            meterTapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }

        // Tier 2 rebuilds with a brand-new AVAudioEngine and minimal direct routing (no EQs/FX/taps)
        if tier >= 2 {
            if let obs = configObserver {
                NotificationCenter.default.removeObserver(obs)
                configObserver = nil
            }
            detachAllFromCurrentEngine()
            engine = AVAudioEngine()
            engine.mainMixerNode.outputVolume = masterVolume
            registerEngineConfigObserver()
        }

        let devID = currentHardwareDeviceID()
        if devID == kAudioObjectUnknown {
            lastAudioError = "Nenhum dispositivo de saída de áudio ativo no macOS"
            emitAudioStateAsync()
            return false
        }

        if currentDeviceUID != "default" || tier == 0 {
            if let au = engine.outputNode.audioUnit {
                var curDev = AudioDeviceID(kAudioObjectUnknown)
                var size = UInt32(MemoryLayout<AudioDeviceID>.size)
                AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &curDev, &size)
                if curDev != devID && (currentDeviceUID != "default" || curDev != kAudioObjectUnknown) {
                    var nextDev = devID
                    let err = AudioUnitSetProperty(
                        au,
                        kAudioOutputUnitProperty_CurrentDevice,
                        kAudioUnitScope_Global,
                        0,
                        &nextDev,
                        UInt32(MemoryLayout<AudioDeviceID>.size)
                    )
                    if err != noErr {
                        NSLog("WorkestraPiano AudioUnitSetProperty CurrentDevice status: %d", err)
                    }
                }
            }
        }

        let currentBuf = WorkestraNativeDSP.bufferFrameSize(forDevice: devID)
        if currentBuf != Int32(targetBufferFrames) {
            _ = WorkestraNativeDSP.setBufferFrameSize(Int32(targetBufferFrames), forDevice: devID)
        }

        let outFmt = engine.outputNode.outputFormat(forBus: 0)
        let devSR = WorkestraNativeDSP.sampleRate(forDevice: devID)
        let rawSR = (devSR > 0) ? devSR : (outFmt.sampleRate > 0 ? outFmt.sampleRate : 44100.0)
        // Keep internal AU graph at standard >= 44.1kHz stereo rate; mainMixer -> outputNode adapts to any hardware SR
        let resolvedSR = (rawSR >= 44100.0 && rawSR <= 192000.0) ? rawSR : 44100.0
        let fmt = AVAudioFormat(standardFormatWithSampleRate: resolvedSR, channels: 2)!
        self.stereoFormat = fmt

        for n in fixedNodes where n.engine === engine {
            engine.disconnectNodeOutput(n)
        }
        if let sn = sourceNode, sn.engine === engine {
            engine.disconnectNodeOutput(sn)
        }
        engine.disconnectNodeOutput(engine.mainMixerNode)

        if tier < 2 {
            for n in fixedNodes {
                attachIfNeeded(n)
            }
        } else {
            var minimalNodes: [AVAudioNode] = [
                pianoSamplerA, pianoSamplerB, pianoGainA, pianoGainB,
                stringsSamplerA, stringsSamplerB, stringsGainA, stringsGainB,
                synthSamplerA, synthSampleGain,
                padMixer, padPreviewPlayer, padTimbreSampler, padTimbreMixer
            ]
            minimalNodes.append(contentsOf: padPlayers)
            for n in minimalNodes {
                attachIfNeeded(n)
            }
        }

        if sourceNode == nil || sourceNode?.engine !== engine || abs(resolvedSR - self.sampleRate) > 1.0 {
            if let old = sourceNode, old.engine === engine {
                engine.detach(old)
            }
            sourceNode = nil
            self.sampleRate = resolvedSR
            self.dsp.setSampleRate(resolvedSR)
            let dspRef = self.dsp!
            let sn = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
                let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
                guard abl.count >= 1,
                      let ch0 = abl[0].mData?.assumingMemoryBound(to: Float.self) else {
                    return noErr
                }
                let ch1 = abl.count >= 2
                    ? (abl[1].mData?.assumingMemoryBound(to: Float.self) ?? ch0)
                    : ch0
                let activeSR = self?.sampleRate ?? resolvedSR
                dspRef.renderLeft(ch0, right: ch1, frameCount: Int32(frameCount), sampleRate: activeSR)
                return noErr
            }
            engine.attach(sn)
            self.sourceNode = sn
        }

        let maxFrameUnits: [AVAudioUnit] = tier >= 2
            ? [pianoSamplerA, pianoSamplerB, stringsSamplerA, stringsSamplerB, synthSamplerA, padTimbreSampler]
            : [
                pianoSamplerA, pianoSamplerB, pianoTimbreEQ,
                stringsSamplerA, stringsSamplerB, stringsFilterA, stringsFilterB,
                synthSamplerA, padTimbreSampler,
                masterEQ, delayUnit, reverbUnit
            ]
        for u in maxFrameUnits {
            configureMaxFrames(u, frames: 4096)
        }

        if tier >= 2 {
            // Tier 2: Minimal safe direct routing directly into mainMixerNode (no EQs, delay, reverb or tap)
            engine.connect(pianoSamplerA, to: pianoGainA, format: fmt)
            engine.connect(pianoSamplerB, to: pianoGainB, format: fmt)
            engine.connect(pianoGainA, to: engine.mainMixerNode, format: fmt)
            engine.connect(pianoGainB, to: engine.mainMixerNode, format: fmt)

            engine.connect(stringsSamplerA, to: stringsGainA, format: fmt)
            engine.connect(stringsSamplerB, to: stringsGainB, format: fmt)
            engine.connect(stringsGainA, to: engine.mainMixerNode, format: fmt)
            engine.connect(stringsGainB, to: engine.mainMixerNode, format: fmt)

            engine.connect(synthSamplerA, to: synthSampleGain, format: fmt)
            engine.connect(synthSampleGain, to: engine.mainMixerNode, format: fmt)

            for p in padPlayers {
                engine.connect(p, to: padMixer, format: fmt)
            }
            engine.connect(padPreviewPlayer, to: padMixer, format: fmt)
            padMixer.outputVolume = 0.9
            engine.connect(padMixer, to: engine.mainMixerNode, format: fmt)

            engine.connect(padTimbreSampler, to: padTimbreMixer, format: fmt)
            padTimbreMixer.outputVolume = 0.85
            engine.connect(padTimbreMixer, to: engine.mainMixerNode, format: fmt)

            if let sn = sourceNode {
                engine.connect(sn, to: engine.mainMixerNode, format: fmt)
            }
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        } else {
            // Piano chain
            engine.connect(pianoSamplerA, to: pianoGainA, format: fmt)
            engine.connect(pianoSamplerB, to: pianoGainB, format: fmt)
            engine.connect(pianoGainA, to: pianoSectionMixer, format: fmt)
            engine.connect(pianoGainB, to: pianoSectionMixer, format: fmt)
            engine.connect(pianoSectionMixer, to: pianoTimbreEQ, format: fmt)
            engine.connect(pianoTimbreEQ, to: preFxBus, format: fmt)

            // Strings chain
            engine.connect(stringsSamplerA, to: stringsFilterA, format: fmt)
            engine.connect(stringsFilterA, to: stringsGainA, format: fmt)
            engine.connect(stringsSamplerB, to: stringsFilterB, format: fmt)
            engine.connect(stringsFilterB, to: stringsGainB, format: fmt)
            engine.connect(stringsGainA, to: stringsSectionMixer, format: fmt)
            engine.connect(stringsGainB, to: stringsSectionMixer, format: fmt)
            engine.connect(stringsSectionMixer, to: preFxBus, format: fmt)

            // Synth Sample, Sample Pads & C++ DSP source node
            engine.connect(synthSamplerA, to: synthSampleGain, format: fmt)
            engine.connect(synthSampleGain, to: preFxBus, format: fmt)
            for p in padPlayers {
                engine.connect(p, to: padMixer, format: fmt)
            }
            engine.connect(padPreviewPlayer, to: padMixer, format: fmt)
            padMixer.outputVolume = 0.9
            engine.connect(padMixer, to: preFxBus, format: fmt)

            engine.connect(padTimbreSampler, to: padTimbreMixer, format: fmt)
            padTimbreMixer.outputVolume = 0.85
            engine.connect(padTimbreMixer, to: preFxBus, format: fmt)

            if let sn = sourceNode {
                engine.connect(sn, to: preFxBus, format: fmt)
            }

            // Tier 0: Full FX chain, Tier 1: Direct preFxBus -> mainMixer (bypass FX)
            if tier == 1 {
                engine.connect(preFxBus, to: engine.mainMixerNode, format: fmt)
            } else {
                engine.connect(preFxBus, to: masterEQ, format: fmt)
                engine.connect(masterEQ, to: delayUnit, format: fmt)
                engine.connect(delayUnit, to: reverbUnit, format: fmt)
                engine.connect(reverbUnit, to: engine.mainMixerNode, format: fmt)
            }
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)

            // Lightweight stereo meter tap on preFxBus mixer
            preFxBus.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buffer, _ in
                guard let self = self else { return }
                let now = CFAbsoluteTimeGetCurrent()
                if now - self.lastMeterSent < 0.09 { return }
                self.lastMeterSent = now

                let frames = Int(buffer.frameLength)
                var peak: Float = 0.0
                if let chData = buffer.floatChannelData {
                    let chCount = Int(buffer.format.channelCount)
                    for c in 0..<chCount {
                        let samples = chData[c]
                        var i = 0
                        while i < frames {
                            let v = abs(samples[i])
                            if v > peak { peak = v }
                            i += 16
                        }
                    }
                }
                peak *= self.engine.mainMixerNode.outputVolume
                let dspPeak = self.dsp.consumeMeterPeak() * self.engine.mainMixerNode.outputVolume
                let finalPeak = max(peak, dspPeak)
                if finalPeak < 0.001 {
                    if self.lastMeterWasZero { return }
                    self.lastMeterWasZero = true
                    DispatchQueue.main.async {
                        self.emitEvent("meter", ["peak": Float(0.0)])
                    }
                    return
                }
                self.lastMeterWasZero = false
                DispatchQueue.main.async {
                    self.emitEvent("meter", ["peak": finalPeak])
                }
            }
            meterTapInstalled = true
        }

        engine.mainMixerNode.outputVolume = masterVolume
        updateSectionGains()

        do {
            engine.prepare()
            try engine.start()
            lastAudioError = nil
            graphTier = tier
            reapplyLoadedSamplers()
            return true
        } catch {
            lastAudioError = "Tier \(tier): \(error.localizedDescription)"
            NSLog("WorkestraPiano CoreAudio start error (tier %d): %@", tier, error.localizedDescription)
            if meterTapInstalled {
                preFxBus.removeTap(onBus: 0)
                meterTapInstalled = false
            }
            if tier < 2 {
                engine.stop()
                engine.reset()
                return connectAndStartAudioGraph(tier: tier + 1)
            }
            emitAudioStateAsync()
            return false
        }
    }

    private func reapplyLoadedSamplers() {
        for (key, st) in samplerStates {
            guard let url = st.url, FileManager.default.fileExists(atPath: url.path) else { continue }
            let parts = key.split(separator: ":")
            guard parts.count == 2 else { continue }
            let sec = String(parts[0])
            let layer = String(parts[1])
            guard let sampler = samplerNode(section: sec, layer: layer) else { continue }
            let bankMSB: UInt8 = (st.bank == 128) ? UInt8(kAUSampler_DefaultPercussionBankMSB) : UInt8(kAUSampler_DefaultMelodicBankMSB)
            let bankLSB: UInt8 = UInt8(max(0, min(127, st.bank & 0x7F)))
            let prog: UInt8 = UInt8(max(0, min(127, st.preset & 0x7F)))
            do {
                try sampler.loadSoundBankInstrument(at: url, program: prog, bankMSB: bankMSB, bankLSB: bankLSB)
            } catch {
                do {
                    try sampler.loadSoundBankInstrument(at: url, program: 0, bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: 0)
                } catch {
                    lastAudioError = "SF2 \(sec):\(layer) falhou: \(error.localizedDescription)"
                    NSLog("WorkestraPiano reapplyLoadedSamplers error (%@:%@): %@", sec, layer, error.localizedDescription)
                }
            }
        }
    }

    private func setupHardwareListeners() {
        registerEngineConfigObserver()

        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self = self else { return }
            if self.currentDeviceUID == "default" {
                self.scheduleGraphRebuild(reason: "DefaultOutputDeviceChanged")
            }
        }
        self.defaultDeviceListenerBlock = block
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, audioQueue, block)
    }

    private func scheduleGraphRebuild(reason: String) {
        audioQueue.async {
            if self.isRebuildingGraph { return }
            if CFAbsoluteTimeGetCurrent() - self.lastRebuildAt < 0.75 && self.engine.isRunning { return }
            self.pendingReconfigWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                NSLog("WorkestraPiano CoreAudio rebuild (\(reason))")
                self.connectAndStartAudioGraph(tier: 0)
                self.emitAudioStateAsync()
            }
            self.pendingReconfigWorkItem = item
            self.audioQueue.asyncAfter(deadline: .now() + 0.25, execute: item)
        }
    }

    private func emitAudioStateAsync() {
        let snap = getAudioMidiStateSnapshot()
        DispatchQueue.main.async {
            self.emitEvent("audioState", snap)
        }
    }

    private func startCpuMonitor() {
        cpuTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: cpuQueue)
        timer.schedule(deadline: .now() + 0.3, repeating: 0.5, leeway: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self = self, let dsp = self.dsp else { return }
            let raw = Double(dsp.consumeCpuLoad())
            let alpha = raw > self.smoothedCpuLoad ? 0.5 : 0.25
            self.smoothedCpuLoad = self.smoothedCpuLoad * (1.0 - alpha) + raw * alpha
            let pct = max(0, min(100, Int(self.smoothedCpuLoad.rounded())))
            if pct != self.lastCpuSentPercent {
                self.lastCpuSentPercent = pct
                DispatchQueue.main.async {
                    self.emitEvent("cpuLoad", ["percent": pct])
                }
            }
        }
        self.cpuTimer = timer
        timer.resume()
    }

    private func configureEQDefaults() {
        // Piano timbre (bypass flat initially)
        let tb = pianoTimbreEQ.bands[0]
        tb.filterType = .parametric
        tb.frequency = 1000
        tb.gain = 0
        tb.bypass = true
        pianoTimbreEQ.bypass = true

        // Strings A & B lowpass filters (bypassed when fully open)
        for eq in [stringsFilterA, stringsFilterB] {
            let b = eq.bands[0]
            b.filterType = .lowPass
            b.frequency = 20000
            b.bandwidth = 0.7
            b.bypass = false
            eq.bypass = true
        }

        // Master 3-band EQ (bypassed when flat)
        let low = masterEQ.bands[0]
        low.filterType = .lowShelf
        low.frequency = 180
        low.gain = 0
        low.bypass = false

        let mid = masterEQ.bands[1]
        mid.filterType = .parametric
        mid.frequency = 1200
        mid.bandwidth = 1.0
        mid.gain = 0
        mid.bypass = false

        let high = masterEQ.bands[2]
        high.filterType = .highShelf
        high.frequency = 4500
        high.gain = 0
        high.bypass = false
        masterEQ.bypass = true
    }

    @discardableResult
    private func ensureAudioEngineRunning() -> Bool {
        if engine.isRunning { return true }
        do {
            engine.prepare()
            try engine.start()
            lastAudioError = nil
            return true
        } catch {
            NSLog("WorkestraPiano quick start failed, rebuilding graph: %@", error.localizedDescription)
            let ok = connectAndStartAudioGraph(tier: 1)
            emitAudioStateAsync()
            return ok
        }
    }

    // MARK: - CoreAudio Devices & Hardware Buffer

    private func currentHardwareDeviceID() -> AudioDeviceID {
        let uid: String? = (currentDeviceUID == "default") ? nil : currentDeviceUID
        return AudioDeviceID(WorkestraNativeDSP.deviceID(forUID: uid))
    }

    private func getAudioMidiStateSnapshot() -> [String: Any] {
        let devID = currentHardwareDeviceID()
        let devName = WorkestraNativeDSP.deviceName(forDevice: devID)
        let outFmt = engine.outputNode.outputFormat(forBus: 0)
        let outSR = outFmt.sampleRate
        let devSR = WorkestraNativeDSP.sampleRate(forDevice: devID)
        let candidateSR = (devSR.isFinite && devSR > 0) ? devSR : (outSR.isFinite && outSR > 0 ? outSR : 44100.0)
        let sr = (candidateSR.isFinite && candidateSR > 0) ? candidateSR : 44100.0
        let buf = max(32, Int(WorkestraNativeDSP.bufferFrameSize(forDevice: devID)))
        let latencyMs = (Double(buf) / sr) * 1000.0
        let devices = WorkestraNativeDSP.listOutputDevices()
        let (inputs, outputs) = listMidiEndpoints()

        stateLock.lock()
        let midiErr = lastMidiError ?? ""
        let packets = midiPacketsReceived
        let connCount = midiConnectedCount
        let proto = midiProtocolMode
        stateLock.unlock()

        return [
            "sampleRate": sr,
            "bufferSamples": buf,
            "latencyMs": latencyMs.isFinite ? latencyMs : 5.8,
            "running": engine.isRunning,
            "graphTier": graphTier,
            "activeDeviceName": devName,
            "outputChannels": Int(outFmt.channelCount),
            "error": lastAudioError ?? "",
            "midiError": midiErr,
            "midiClientReady": midiClient != 0,
            "midiInputPortReady": midiInputPort != 0,
            "midiSourcesCount": MIDIGetNumberOfSources(),
            "midiConnectedCount": connCount,
            "midiPacketsReceived": packets,
            "midiProtocol": proto,
            "audioDevices": devices,
            "midiInputs": inputs,
            "midiOutputs": outputs
        ]
    }

    func emitCurrentStatesToWebUI() {
        audioQueue.async {
            if !self.engine.isRunning {
                _ = self.connectAndStartAudioGraph(tier: 0)
            }
            let audioSnap = self.getAudioMidiStateSnapshot()
            DispatchQueue.main.async {
                self.emitEvent("audioState", audioSnap)
            }
        }
        midiQueue.async {
            self.reconnectAllMidiSources()
            let (inputs, outputs) = self.listMidiEndpoints()
            self.stateLock.lock()
            let midiErr = self.lastMidiError ?? ""
            let packets = self.midiPacketsReceived
            let connCount = self.midiConnectedCount
            let proto = self.midiProtocolMode
            self.stateLock.unlock()
            DispatchQueue.main.async {
                self.emitEvent("midiDevices", [
                    "inputs": inputs,
                    "outputs": outputs,
                    "midiError": midiErr,
                    "midiClientReady": self.midiClient != 0,
                    "midiInputPortReady": self.midiInputPort != 0,
                    "midiSourcesCount": MIDIGetNumberOfSources(),
                    "midiConnectedCount": connCount,
                    "midiPacketsReceived": packets,
                    "midiProtocol": proto
                ])
            }
        }
    }

    func getAudioMidiState() -> [String: Any] {
        cpuQueue.async { [weak self] in
            guard let self = self else { return }
            let pct = max(0, min(100, Int(self.smoothedCpuLoad.rounded())))
            DispatchQueue.main.async {
                self.emitEvent("cpuLoad", ["percent": pct])
            }
        }
        ensureCoreMIDIReadyOnMain()
        midiQueue.sync {
            reconnectAllMidiSources()
        }
        return audioQueue.sync {
            return getAudioMidiStateSnapshot()
        }
    }

    func rescanMidi() -> [String: Any] {
        ensureCoreMIDIReadyOnMain(forceReinitIfBroken: true)
        var shouldRestart = false
        midiQueue.sync {
            if midiInputPort != 0 {
                for (ep, _) in connectedSources {
                    MIDIPortDisconnectSource(midiInputPort, ep)
                }
                connectedSources.removeAll()
            }
            reconnectAllMidiSources()
            if MIDIGetNumberOfSources() == 0 {
                shouldRestart = true
            }
        }
        if shouldRestart {
            MIDIRestart()
            midiQueue.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                guard let self = self else { return }
                self.reconnectAllMidiSources()
                let (inputs, outputs) = self.listMidiEndpoints()
                DispatchQueue.main.async {
                    self.emitEvent("midiDevices", [
                        "inputs": inputs,
                        "outputs": outputs
                    ])
                }
            }
        }
        return audioQueue.sync {
            return getAudioMidiStateSnapshot()
        }
    }

    func setAudioDevice(uid: String) -> [String: Any] {
        return audioQueue.sync {
            let nextUID = uid.isEmpty ? "default" : uid
            if nextUID != currentDeviceUID || !engine.isRunning {
                currentDeviceUID = nextUID
                connectAndStartAudioGraph(tier: 0)
            }
            return getAudioMidiStateSnapshot()
        }
    }

    func setSampleRate(_ sr: Double) -> [String: Any] {
        return audioQueue.sync {
            let devID = currentHardwareDeviceID()
            let prev = WorkestraNativeDSP.sampleRate(forDevice: devID)
            let actual = WorkestraNativeDSP.setSampleRate(sr, forDevice: devID)
            if abs(actual - prev) > 1.0 || abs(sr - sampleRate) > 1.0 || !engine.isRunning {
                connectAndStartAudioGraph(tier: 0)
            }
            return getAudioMidiStateSnapshot()
        }
    }

    func setBufferSamples(_ samples: Int) -> [String: Any] {
        return audioQueue.sync {
            let clamped = max(32, min(4096, samples))
            let devID = currentHardwareDeviceID()
            let prev = Int(WorkestraNativeDSP.bufferFrameSize(forDevice: devID))
            targetBufferFrames = clamped
            let actual = Int(WorkestraNativeDSP.setBufferFrameSize(Int32(targetBufferFrames), forDevice: devID))
            if (actual != prev && actual != targetBufferFrames) || actual != prev || !engine.isRunning {
                connectAndStartAudioGraph(tier: 0)
            }
            return getAudioMidiStateSnapshot()
        }
    }

    func restartAudioEngine() -> [String: Any] {
        return audioQueue.sync {
            engine.stop()
            engine.reset()
            connectAndStartAudioGraph(tier: 0)
            return getAudioMidiStateSnapshot()
        }
    }

    // MARK: - CoreMIDI

    private func ensureCoreMIDIReadyOnMain(forceReinitIfBroken: Bool = false) {
        let needsSetup = (midiClient == 0 || midiInputPort == 0)
        guard needsSetup || forceReinitIfBroken else { return }
        if !needsSetup { return }
        if Thread.isMainThread {
            setupCoreMIDI()
        } else {
            DispatchQueue.main.sync {
                if self.midiClient == 0 || self.midiInputPort == 0 {
                    self.setupCoreMIDI()
                }
            }
        }
    }

    private func setupCoreMIDI() {
        var status: OSStatus = noErr
        if midiClient == 0 {
            status = MIDIClientCreateWithBlock("WorkestraPiano" as CFString, &midiClient) { [weak self] _ in
                guard let self = self else { return }
                self.midiQueue.async {
                    self.reconnectAllMidiSources()
                    let (inputs, outputs) = self.listMidiEndpoints()
                    self.stateLock.lock()
                    let midiErr = self.lastMidiError ?? ""
                    let packets = self.midiPacketsReceived
                    let proto = self.midiProtocolMode
                    self.stateLock.unlock()
                    DispatchQueue.main.async {
                        self.emitEvent("midiDevices", [
                            "inputs": inputs,
                            "outputs": outputs,
                            "midiError": midiErr,
                            "midiClientReady": self.midiClient != 0,
                            "midiInputPortReady": self.midiInputPort != 0,
                            "midiSourcesCount": MIDIGetNumberOfSources(),
                            "midiConnectedCount": self.connectedSources.count,
                            "midiPacketsReceived": packets,
                            "midiProtocol": proto,
                            "notice": "Dispositivos CoreMIDI atualizados"
                        ])
                    }
                }
            }
            guard status == noErr, midiClient != 0 else {
                stateLock.lock()
                lastMidiError = "MIDIClientCreateWithBlock falhou (\(status))"
                midiProtocolMode = "client-error-\(status)"
                stateLock.unlock()
                NSLog("WorkestraPiano CoreMIDI client error: %d", status)
                return
            }
        }

        if midiInputPort == 0 {
            status = MIDIInputPortCreateWithProtocol(
                midiClient,
                "WorkestraInput" as CFString,
                ._1_0,
                &midiInputPort
            ) { [weak self] eventList, srcConnRefCon in
                guard let self = self else { return }
                let srcUid: Int32 = srcConnRefCon != nil
                    ? Int32(bitPattern: UInt32(truncatingIfNeeded: UInt(bitPattern: srcConnRefCon)))
                    : 0
                self.handleMIDIEventList(eventList, sourceUID: srcUid)
            }

            if status == noErr && midiInputPort != 0 {
                stateLock.lock()
                lastMidiError = nil
                midiProtocolMode = "ump-1.0"
                stateLock.unlock()
            } else {
                NSLog("WorkestraPiano MIDIInputPortCreateWithProtocol error (%d), falling back to legacy port", status)
                midiInputPort = 0
                let legacyStatus = MIDIInputPortCreateWithBlock(
                    midiClient,
                    "WorkestraInput" as CFString,
                    &midiInputPort
                ) { [weak self] packetList, srcConnRefCon in
                    guard let self = self else { return }
                    let srcUid: Int32 = srcConnRefCon != nil
                        ? Int32(bitPattern: UInt32(truncatingIfNeeded: UInt(bitPattern: srcConnRefCon)))
                        : 0
                    self.handleMIDIPacketList(packetList, sourceUID: srcUid)
                }
                if legacyStatus == noErr && midiInputPort != 0 {
                    stateLock.lock()
                    lastMidiError = nil
                    midiProtocolMode = "legacy-1.0"
                    stateLock.unlock()
                } else {
                    stateLock.lock()
                    lastMidiError = "MIDIInputPortCreate falhou (UMP:\(status), Legacy:\(legacyStatus))"
                    midiProtocolMode = "port-error-\(legacyStatus)"
                    stateLock.unlock()
                    NSLog("WorkestraPiano CoreMIDI input port error: %d", legacyStatus)
                    return
                }
            }
        }

        if midiOutputPort == 0 {
            MIDIOutputPortCreate(midiClient, "WorkestraOutput" as CFString, &midiOutputPort)
        }

        midiQueue.async { [weak self] in
            guard let self = self else { return }
            self.reconnectAllMidiSources()
        }

        // Delayed sweeps in case MIDIServer / USB controllers finish enumeration asynchronously after launch
        for delay in [0.8, 2.4] {
            midiQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                self.reconnectAllMidiSources()
                let (inputs, outputs) = self.listMidiEndpoints()
                self.stateLock.lock()
                let midiErr = self.lastMidiError ?? ""
                let packets = self.midiPacketsReceived
                let proto = self.midiProtocolMode
                self.stateLock.unlock()
                DispatchQueue.main.async {
                    self.emitEvent("midiDevices", [
                        "inputs": inputs,
                        "outputs": outputs,
                        "midiError": midiErr,
                        "midiClientReady": self.midiClient != 0,
                        "midiInputPortReady": self.midiInputPort != 0,
                        "midiSourcesCount": MIDIGetNumberOfSources(),
                        "midiConnectedCount": self.connectedSources.count,
                        "midiPacketsReceived": packets,
                        "midiProtocol": proto
                    ])
                }
            }
        }
    }

    private func effectiveUID(for ep: MIDIEndpointRef) -> MIDIUniqueID {
        var uid: MIDIUniqueID = 0
        let err = MIDIObjectGetIntegerProperty(ep, kMIDIPropertyUniqueID, &uid)
        if err != noErr || uid == 0 {
            let fallback = Int32(bitPattern: UInt32(ep))
            return fallback == 0 ? 1 : fallback
        }
        return uid
    }

    private func reconnectAllMidiSources() {
        guard midiInputPort != 0 else { return }
        let count = MIDIGetNumberOfSources()
        var currentEndpoints = Set<MIDIEndpointRef>()
        for i in 0..<count {
            let src = MIDIGetSource(i)
            guard src != 0 else { continue }
            currentEndpoints.insert(src)
            let uid = effectiveUID(for: src)
            if connectedSources[src] != uid {
                if connectedSources[src] != nil {
                    MIDIPortDisconnectSource(midiInputPort, src)
                }
                let refCon = UnsafeMutableRawPointer(bitPattern: UInt(UInt32(bitPattern: uid)))
                let connStatus = MIDIPortConnectSource(midiInputPort, src, refCon)
                if connStatus == noErr {
                    connectedSources[src] = uid
                } else {
                    stateLock.lock()
                    lastMidiError = "MIDIPortConnectSource erro \(connStatus)"
                    stateLock.unlock()
                    NSLog("WorkestraPiano MIDIPortConnectSource failed for endpoint %u: %d", src, connStatus)
                }
            }
        }
        for (ep, _) in connectedSources where !currentEndpoints.contains(ep) {
            MIDIPortDisconnectSource(midiInputPort, ep)
            connectedSources.removeValue(forKey: ep)
        }
        stateLock.lock()
        midiConnectedCount = connectedSources.count
        stateLock.unlock()
    }

    private func midiStringProperty(_ obj: MIDIObjectRef, _ prop: CFString) -> String? {
        var cfStr: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(obj, prop, &cfStr) == noErr,
              let str = cfStr?.takeRetainedValue() as String? else {
            return nil
        }
        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func listMidiEndpoints() -> ([[String: String]], [[String: String]]) {
        var inputs: [[String: String]] = []
        let inCount = MIDIGetNumberOfSources()
        for i in 0..<inCount {
            let ep = MIDIGetSource(i)
            if ep != 0 {
                inputs.append(endpointInfo(ep, fallback: "MIDI Input \(i + 1)"))
            }
        }
        var outputs: [[String: String]] = []
        let outCount = MIDIGetNumberOfDestinations()
        for i in 0..<outCount {
            let ep = MIDIGetDestination(i)
            if ep != 0 {
                outputs.append(endpointInfo(ep, fallback: "MIDI Output \(i + 1)"))
            }
        }
        return (inputs, outputs)
    }

    private func endpointInfo(_ ep: MIDIEndpointRef, fallback: String) -> [String: String] {
        var name = midiStringProperty(ep, kMIDIPropertyDisplayName)
            ?? midiStringProperty(ep, kMIDIPropertyName)

        if name == nil {
            var entity: MIDIEntityRef = 0
            if MIDIEndpointGetEntity(ep, &entity) == noErr, entity != 0 {
                name = midiStringProperty(entity, kMIDIPropertyDisplayName)
                    ?? midiStringProperty(entity, kMIDIPropertyName)
                if name == nil {
                    var dev: MIDIDeviceRef = 0
                    if MIDIEntityGetDevice(entity, &dev) == noErr, dev != 0 {
                        let mfr = midiStringProperty(dev, kMIDIPropertyManufacturer)
                        let mod = midiStringProperty(dev, kMIDIPropertyModel)
                        let devName = midiStringProperty(dev, kMIDIPropertyName)
                        if let devName = devName {
                            name = devName
                        } else if let mfr = mfr, let mod = mod {
                            name = "\(mfr) \(mod)"
                        } else {
                            name = mfr ?? mod
                        }
                    }
                }
            }
        }
        let uid = effectiveUID(for: ep)
        return ["id": "\(uid)", "name": name ?? fallback]
    }

    private func isMidiSourceAllowed(_ sourceUID: Int32) -> Bool {
        let uidStr = "\(sourceUID)"
        stateLock.lock()
        let allowed = enabledMidiInputIDs
        let filter = midiInputFilter
        stateLock.unlock()
        if let allowed = allowed {
            return allowed.contains(uidStr)
        }
        return filter == "all" || filter == uidStr
    }

    private func dispatchMidiChannelMessage(st: UInt8, d1: UInt8, d2: UInt8) {
        stateLock.lock()
        let chFilter = midiChannelFilter
        let isDirect = directMidi
        stateLock.unlock()

        let ch = Int(st & 0x0F) + 1
        if chFilter != "all" && Int(chFilter) != ch {
            return
        }

        let cmd = st & 0xF0
        let isPC = (cmd == 0xC0)
        let willHandleNatively = isDirect && !isPC && !(cmd == 0xB0 && d1 != 64 && d1 != 1)
        if willHandleNatively {
            audioQueue.async {
                self.processDirectMidi(cmd: cmd, d1: d1, d2: d2)
            }
        }

        // Throttle continuous controller visual IPC when audio is already processed natively
        let isHighRateCC = willHandleNatively && ((cmd == 0xB0 && d1 != 64) || cmd == 0xE0)
        if isHighRateCC {
            let now = CFAbsoluteTimeGetCurrent()
            if now - lastVisualMidiCC < 0.06 { return }
            lastVisualMidiCC = now
        }

        DispatchQueue.main.async {
            self.emitEvent("midiEvent", [
                "status": Int(st),
                "data1": Int(d1),
                "data2": Int(d2),
                "handledNatively": willHandleNatively
            ])
        }
    }

    private func handleMIDIEventList(_ eventList: UnsafePointer<MIDIEventList>, sourceUID: Int32) {
        stateLock.lock()
        midiPacketsReceived += 1
        let thruOn = midiThru
        let outId = midiOutputId
        stateLock.unlock()

        if !isMidiSourceAllowed(sourceUID) {
            return
        }

        // MIDI Thru forwarding (macOS 11+ UMP)
        if thruOn, midiOutputPort != 0, outId != "none", let targetUid = MIDIUniqueID(outId) {
            var obj: MIDIObjectRef = 0
            var type: MIDIObjectType = .other
            if MIDIObjectFindByUniqueID(targetUid, &obj, &type) == noErr {
                MIDISendEventList(midiOutputPort, obj, eventList)
            }
        }

        for packetPtr in eventList.unsafeSequence() {
            let wc = min(Int(packetPtr.pointee.wordCount), 64)
            var words: [UInt32] = []
            words.reserveCapacity(wc)
            withUnsafeBytes(of: packetPtr.pointee.words) { raw in
                let bound = raw.bindMemory(to: UInt32.self)
                for idx in 0..<wc {
                    words.append(bound[idx])
                }
            }

            var wi = 0
            while wi < words.count {
                let w0 = words[wi]
                let mt = (w0 >> 28) & 0xF
                switch mt {
                case 0x2:
                    // MIDI 1.0 Channel Voice (32-bit, 1 word)
                    let st = UInt8((w0 >> 16) & 0xFF)
                    let d1 = UInt8((w0 >> 8) & 0x7F)
                    let d2 = UInt8(w0 & 0x7F)
                    if st >= 0x80 && st < 0xF0 {
                        dispatchMidiChannelMessage(st: st, d1: d1, d2: d2)
                    }
                    wi += 1

                case 0x4:
                    // MIDI 2.0 Channel Voice (64-bit, 2 words)
                    guard wi + 1 < words.count else { wi = words.count; break }
                    let w1 = words[wi + 1]
                    let st = UInt8((w0 >> 16) & 0xFF)
                    let cmd = st & 0xF0
                    let ch = st & 0x0F
                    let idxOrNote = UInt8((w0 >> 8) & 0x7F)
                    switch cmd {
                    case 0x90:
                        let vel16 = (w1 >> 16) & 0xFFFF
                        if vel16 == 0 {
                            dispatchMidiChannelMessage(st: 0x80 | ch, d1: idxOrNote, d2: 0)
                        } else {
                            let vel7 = UInt8(max(1, min(127, Int((vel16 >> 9) & 0x7F))))
                            dispatchMidiChannelMessage(st: 0x90 | ch, d1: idxOrNote, d2: vel7)
                        }
                    case 0x80:
                        let vel7 = UInt8(min(127, Int((w1 >> 25) & 0x7F)))
                        dispatchMidiChannelMessage(st: 0x80 | ch, d1: idxOrNote, d2: vel7)
                    case 0xB0:
                        let val7 = UInt8(min(127, Int((w1 >> 25) & 0x7F)))
                        dispatchMidiChannelMessage(st: 0xB0 | ch, d1: idxOrNote, d2: val7)
                    case 0xE0:
                        let val14 = Int((w1 >> 18) & 0x3FFF)
                        dispatchMidiChannelMessage(st: 0xE0 | ch, d1: UInt8(val14 & 0x7F), d2: UInt8((val14 >> 7) & 0x7F))
                    case 0xC0:
                        let prog = UInt8((w1 >> 24) & 0x7F)
                        dispatchMidiChannelMessage(st: 0xC0 | ch, d1: prog, d2: 0)
                    case 0xA0:
                        let pres7 = UInt8(min(127, Int((w1 >> 25) & 0x7F)))
                        dispatchMidiChannelMessage(st: 0xA0 | ch, d1: idxOrNote, d2: pres7)
                    case 0xD0:
                        let pres7 = UInt8(min(127, Int((w1 >> 25) & 0x7F)))
                        dispatchMidiChannelMessage(st: 0xD0 | ch, d1: pres7, d2: 0)
                    default:
                        break
                    }
                    wi += 2

                case 0x0, 0x1, 0x6, 0x7:
                    wi += 1
                case 0x3, 0x8, 0x9, 0xA:
                    wi += 2
                case 0xB, 0xC:
                    wi += 3
                default: // 0x5, 0xD, 0xE, 0xF (128-bit UMP)
                    wi += 4
                }
            }
        }
    }

    private func handleMIDIPacketList(_ packetList: UnsafePointer<MIDIPacketList>, sourceUID: Int32) {
        stateLock.lock()
        midiPacketsReceived += 1
        stateLock.unlock()

        if !isMidiSourceAllowed(sourceUID) {
            return
        }

        // MIDI Thru forwarding
        if midiThru, midiOutputPort != 0, midiOutputId != "none", let targetUid = MIDIUniqueID(midiOutputId) {
            var obj: MIDIObjectRef = 0
            var type: MIDIObjectType = .other
            if MIDIObjectFindByUniqueID(targetUid, &obj, &type) == noErr {
                MIDISend(midiOutputPort, obj, packetList)
            }
        }

        for packetPtr in packetList.unsafeSequence() {
            let len = min(Int(packetPtr.pointee.length), 256)
            withUnsafeBytes(of: packetPtr.pointee.data) { raw in
                var idx = 0
                var runningStatus: UInt8 = 0
                while idx < len {
                    let b0 = raw[idx]
                    let st: UInt8
                    if b0 >= 0xF8 {
                        idx += 1
                        continue
                    } else if b0 >= 0xF0 {
                        runningStatus = 0
                        if b0 == 0xF0 {
                            while idx < len && raw[idx] != 0xF7 { idx += 1 }
                            idx += 1
                        } else if b0 == 0xF1 || b0 == 0xF3 {
                            idx += 2
                        } else if b0 == 0xF2 {
                            idx += 3
                        } else {
                            idx += 1
                        }
                        continue
                    } else if b0 >= 0x80 {
                        st = b0
                        runningStatus = st
                        idx += 1
                    } else if runningStatus >= 0x80 && runningStatus < 0xF0 {
                        st = runningStatus
                    } else {
                        idx += 1
                        continue
                    }

                    let cmd = st & 0xF0
                    let dataLen = (cmd == 0xC0 || cmd == 0xD0) ? 1 : 2
                    guard idx + dataLen <= len else { break }
                    let d1 = raw[idx]
                    let d2 = dataLen == 2 ? raw[idx + 1] : 0
                    idx += dataLen
                    dispatchMidiChannelMessage(st: st, d1: d1, d2: d2)
                }
            }
        }
    }

    private func processDirectMidi(cmd: UInt8, d1: UInt8, d2: UInt8) {
        if cmd == 0x90 && d2 > 0 {
            triggerKeyOn(key: Int(d1), rawVel: Int(d2))
        } else if cmd == 0x80 || (cmd == 0x90 && d2 == 0) {
            triggerKeyOff(key: Int(d1))
        } else if cmd == 0xB0 && d1 == 64 {
            let down = d2 >= 64
            for sec in ["piano", "synth", "strings"] {
                if down && sectionOn[sec] != true { continue }
                for L in ["A", "B"] {
                    if !down || (layerRouting[sec]?[L]?.on == true) {
                        setSustain(section: sec, layer: L, down: down)
                    }
                }
            }
        } else if cmd == 0xB0 && d1 == 1 {
            let val = Double(d2) / 127.0
            for sec in ["piano", "synth", "strings"] where sectionOn[sec] == true {
                setModWheel(section: sec, layer: "A", value: val)
                setModWheel(section: sec, layer: "B", value: val)
            }
        } else if cmd == 0xE0 {
            let raw = (Int(d2) << 7) | Int(d1)
            let x = Double(raw - 8192) / 8192.0
            for sec in ["piano", "synth", "strings"] where sectionOn[sec] == true {
                setPitchBend(section: sec, layer: "A", raw: raw, semis: x * 2.0)
                setPitchBend(section: sec, layer: "B", raw: raw, semis: x * 2.0)
            }
        }
    }

    private func triggerKeyOn(key: Int, rawVel: Int) {
        triggerKeyOff(key: key)
        let norm = Double(rawVel) / 127.0
        let vel = max(1, min(127, Int((127.0 * pow(norm, velCurve)).rounded())))
        var sent: [(section: String, layer: String, note: Int)] = []

        for sec in ["organ", "piano", "synth", "strings"] {
            guard sectionOn[sec] == true else { continue }
            let secOct = sectionOctave[sec] ?? 0
            for L in ["A", "B"] {
                guard let lr = layerRouting[sec]?[L], lr.on else { continue }
                if lr.zone == "lower" && key >= splitNote { continue }
                if lr.zone == "upper" && key < splitNote { continue }
                let note = key + transpose + (secOct + lr.octave) * 12
                guard note >= 0 && note <= 127 else { continue }
                sent.append((sec, L, note))
                triggerSectionNoteOn(section: sec, layer: L, note: note, vel: vel, isSample: synthIsSample)
            }
        }
        heldKeys[key] = sent
    }

    private func triggerKeyOff(key: Int) {
        guard let sent = heldKeys.removeValue(forKey: key) else { return }
        for item in sent {
            triggerSectionNoteOff(section: item.section, layer: item.layer, note: item.note)
        }
    }

    // MARK: - Sampler & Synthesis Control

    private func samplerNode(section: String, layer: String) -> AVAudioUnitSampler? {
        switch (section, layer) {
        case ("piano", "A"): return pianoSamplerA
        case ("piano", "B"): return pianoSamplerB
        case ("strings", "A"): return stringsSamplerA
        case ("strings", "B"): return stringsSamplerB
        case ("synth", "A"): return synthSamplerA
        default: return nil
        }
    }

    private func triggerSectionNoteOn(section: String, layer: String, note: Int, vel: Int, isSample: Bool) {
        if !engine.isRunning { _ = ensureAudioEngineRunning() }
        let n = UInt8(max(0, min(127, note)))
        let v = UInt8(max(1, min(127, vel)))
        switch section {
        case "organ":
            dsp.organNoteOn(layer == "B" ? 1 : 0, note: Int32(note))
        case "synth":
            if layer == "A" && (isSample || synthIsSample) {
                if samplerStates["synth:A"]?.url != nil {
                    synthSamplerA.startNote(n, withVelocity: v, onChannel: 0)
                } else {
                    dsp.synthNoteOn(0, note: Int32(note), velocity: Int32(vel))
                }
            } else {
                dsp.synthNoteOn(layer == "B" ? 1 : 0, note: Int32(note), velocity: Int32(vel))
            }
        case "piano", "strings":
            let key = "\(section):\(layer)"
            if samplerStates[key]?.url != nil {
                samplerNode(section: section, layer: layer)?.startNote(n, withVelocity: v, onChannel: 0)
            } else {
                // Fallback to built-in C++ native synth DSP when no SoundFont is loaded yet
                dsp.synthNoteOn(layer == "B" ? 1 : 0, note: Int32(note), velocity: Int32(vel))
            }
        default:
            break
        }
    }

    private func triggerSectionNoteOff(section: String, layer: String, note: Int) {
        let n = UInt8(max(0, min(127, note)))
        switch section {
        case "organ":
            dsp.organNoteOff(layer == "B" ? 1 : 0, note: Int32(note))
        case "synth":
            if layer == "A" && synthIsSample {
                synthSamplerA.stopNote(n, onChannel: 0)
            }
            dsp.synthNoteOff(layer == "B" ? 1 : 0, note: Int32(note))
        case "piano", "strings":
            let key = "\(section):\(layer)"
            if samplerStates[key]?.url != nil {
                samplerNode(section: section, layer: layer)?.stopNote(n, onChannel: 0)
            }
            dsp.synthNoteOff(layer == "B" ? 1 : 0, note: Int32(note))
        default:
            break
        }
    }

    private func setSustain(section: String, layer: String, down: Bool) {
        switch section {
        case "synth":
            if layer == "A" { synthSamplerA.sendController(64, withValue: down ? 127 : 0, onChannel: 0) }
            dsp.synthSustain(layer == "B" ? 1 : 0, down: down)
        case "piano", "strings":
            samplerNode(section: section, layer: layer)?.sendController(64, withValue: down ? 127 : 0, onChannel: 0)
            if samplerStates["\(section):\(layer)"]?.url == nil {
                dsp.synthSustain(layer == "B" ? 1 : 0, down: down)
            }
        default:
            break
        }
    }

    private func setModWheel(section: String, layer: String, value: Double) {
        let ccVal = UInt8(max(0, min(127, Int((value * 127.0).rounded()))))
        switch section {
        case "synth":
            if layer == "A" { synthSamplerA.sendController(1, withValue: ccVal, onChannel: 0) }
            dsp.synthMod(layer == "B" ? 1 : 0, value: value)
        case "piano", "strings":
            samplerNode(section: section, layer: layer)?.sendController(1, withValue: ccVal, onChannel: 0)
            if samplerStates["\(section):\(layer)"]?.url == nil {
                dsp.synthMod(layer == "B" ? 1 : 0, value: value)
            }
        default:
            break
        }
    }

    private func setPitchBend(section: String, layer: String, raw: Int?, semis: Double?) {
        let bend14: UInt16
        if let raw = raw {
            bend14 = UInt16(max(0, min(16383, raw)))
        } else if let semis = semis {
            bend14 = UInt16(max(0, min(16383, Int((8192.0 + (semis / 2.0) * 8191.0).rounded()))))
        } else {
            bend14 = 8192
        }
        let computedSemis = semis ?? (Double(Int(bend14) - 8192) / 8191.0) * 2.0
        switch section {
        case "synth":
            if layer == "A" { synthSamplerA.sendPitchBend(bend14, onChannel: 0) }
            dsp.synthBend(layer == "B" ? 1 : 0, semitones: computedSemis)
        case "piano", "strings":
            samplerNode(section: section, layer: layer)?.sendPitchBend(bend14, onChannel: 0)
            if samplerStates["\(section):\(layer)"]?.url == nil {
                dsp.synthBend(layer == "B" ? 1 : 0, semitones: computedSemis)
            }
        default:
            break
        }
    }

    private func allNotesOff(section: String, layer: String?) {
        switch section {
        case "organ":
            dsp.organAllOff()
        case "synth":
            synthSamplerA.sendMIDIEvent(0xB0, data1: 123, data2: 0)
            synthSamplerA.sendMIDIEvent(0xB0, data1: 120, data2: 0)
            if layer == "A" { dsp.synthAllOff(0) }
            else if layer == "B" { dsp.synthAllOff(1) }
            else { dsp.synthAllOff(-1) }
        case "piano", "strings":
            let layers = layer != nil ? [layer!] : ["A", "B"]
            for L in layers {
                if let s = samplerNode(section: section, layer: L) {
                    s.sendController(64, withValue: 0, onChannel: 0)
                    s.sendMIDIEvent(0xB0, data1: 123, data2: 0)
                    s.sendMIDIEvent(0xB0, data1: 120, data2: 0)
                }
                dsp.synthAllOff(L == "B" ? 1 : 0)
            }
        default:
            break
        }
    }

    // MARK: - Foundation SoundFont Loading & Cache

    func getLocalLibrary() -> [String: [[String: Any]]] {
        let fm = FileManager.default
        let exts = Set(["sf2", "npno", "nsmp", "nsmp3", "nsmp4", "svz", "wav"])

        func scan(_ dir: URL) -> [[String: Any]] {
            guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey], options: [.skipsHiddenFiles]) else {
                return []
            }
            var out: [[String: Any]] = []
            for url in items {
                guard let rv = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                      rv.isRegularFile == true else { continue }
                let ext = url.pathExtension.lowercased()
                if exts.contains(ext) {
                    out.append([
                        "name": url.lastPathComponent,
                        "size": rv.fileSize ?? 0,
                        "path": url.path
                    ])
                }
            }
            return out.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        }

        let rootFiles = scan(soundsRootURL)
        let piano = scan(soundsRootURL.appendingPathComponent("Piano")) + rootFiles
        let strings = scan(soundsRootURL.appendingPathComponent("Strings"))
        let synth = scan(soundsRootURL.appendingPathComponent("Synth"))
        return ["piano": piano, "strings": strings, "synth": synth]
    }

    func checkCachedSf2(key: String) -> [String: Any] {
        let clean = key.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
        let dest = convertedCacheURL.appendingPathComponent("\(clean).sf2")
        if FileManager.default.fileExists(atPath: dest.path),
           let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
           let size = (attrs[.size] as? NSNumber)?.intValue, size > 0 {
            return ["exists": true, "path": dest.path, "size": size]
        }
        return ["exists": false]
    }

    func cacheConvertedSf2(name: String, key: String, base64: String) throws -> [String: Any] {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            throw NSError(domain: "WorkestraPiano", code: 1, userInfo: [NSLocalizedDescriptionKey: "Base64 inválido ao salvar cache."])
        }
        let clean = key.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
        let fileName = clean.isEmpty ? name : "\(clean).sf2"
        let dest = convertedCacheURL.appendingPathComponent(fileName)
        try data.write(to: dest, options: .atomic)
        return ["path": dest.path]
    }

    // MARK: - Native Workstation Sample Pads

    private func resolvePadURL(name: String, path: String?, base64: String?) throws -> URL {
        if let path = path, FileManager.default.fileExists(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        if let base64 = base64, let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
            let padsDir = convertedCacheURL.appendingPathComponent("Pads", isDirectory: true)
            try? FileManager.default.createDirectory(at: padsDir, withIntermediateDirectories: true)
            let safe = name.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
            let dest = padsDir.appendingPathComponent(safe.isEmpty ? "pad.wav" : safe)
            try data.write(to: dest, options: .atomic)
            return dest
        }
        throw NSError(domain: "WorkestraPiano", code: 10, userInfo: [NSLocalizedDescriptionKey: "Amostra de pad não encontrada."])
    }

    private func decodeAudioToEngineBuffer(url: URL) throws -> (buffer: AVAudioPCMBuffer, duration: Double) {
        let file = try AVAudioFile(forReading: url)
        let srcFormat = file.processingFormat
        let srcFrames = AVAudioFrameCount(file.length)
        let duration = srcFormat.sampleRate > 0 ? Double(file.length) / srcFormat.sampleRate : 0.0

        guard let srcBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: srcFrames) else {
            throw NSError(domain: "WorkestraPiano", code: 11, userInfo: [NSLocalizedDescriptionKey: "Falha ao alocar buffer de áudio."])
        }
        try file.read(into: srcBuffer)

        if srcFormat.sampleRate == stereoFormat.sampleRate && srcFormat.channelCount == stereoFormat.channelCount {
            return (srcBuffer, duration)
        }

        guard let converter = AVAudioConverter(from: srcFormat, to: stereoFormat) else {
            throw NSError(domain: "WorkestraPiano", code: 12, userInfo: [NSLocalizedDescriptionKey: "Formato de áudio incompatível."])
        }
        let ratio = stereoFormat.sampleRate / max(1.0, srcFormat.sampleRate)
        let outFrames = AVAudioFrameCount(max(1.0, ceil(Double(srcFrames) * ratio)))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: stereoFormat, frameCapacity: outFrames) else {
            throw NSError(domain: "WorkestraPiano", code: 13, userInfo: [NSLocalizedDescriptionKey: "Falha ao converter buffer de áudio."])
        }
        var consumed = false
        var convError: NSError?
        converter.convert(to: outBuffer, error: &convError) { _, outStatus in
            if consumed {
                outStatus.pointee = .endOfStream
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return srcBuffer
        }
        if let err = convError { throw err }
        return (outBuffer, duration)
    }

    func loadPadSample(index: Int, name: String, path: String?, base64: String?) throws -> [String: Any] {
        guard index >= 0 && index < padPlayers.count else {
            throw NSError(domain: "WorkestraPiano", code: 14, userInfo: [NSLocalizedDescriptionKey: "Pad inválido"])
        }
        let url = try resolvePadURL(name: name, path: path, base64: base64)
        let (buf, duration) = try decodeAudioToEngineBuffer(url: url)
        padBuffers[index] = buf
        return [
            "path": url.path,
            "duration": duration,
            "kind": duration > 3.0 ? "loop" : "pad"
        ]
    }

    func playPadSample(index: Int, loop: Bool) {
        guard index >= 0 && index < padPlayers.count, let buf = padBuffers[index] else { return }
        let player = padPlayers[index]
        let gen = (padGeneration[index] ?? 0) + 1
        padGeneration[index] = gen
        player.stop()
        if !engine.isRunning { _ = ensureAudioEngineRunning() }
        let opts: AVAudioPlayerNodeBufferOptions = loop ? .loops : []
        player.scheduleBuffer(buf, at: nil, options: opts) { [weak self] in
            guard let self = self else { return }
            self.audioQueue.async {
                if self.padGeneration[index] == gen && !loop {
                    DispatchQueue.main.async {
                        self.emitEvent("padEnded", ["index": index])
                    }
                }
            }
        }
        player.play()
    }

    func stopPadSample(index: Int) {
        guard index >= 0 && index < padPlayers.count else { return }
        padGeneration[index] = (padGeneration[index] ?? 0) + 1
        padPlayers[index].stop()
    }

    func stopAllPads() {
        for i in 0..<padPlayers.count {
            padGeneration[i] = (padGeneration[i] ?? 0) + 1
            padPlayers[i].stop()
        }
        padPreviewPlayer.stop()
        updateContinuousPad(playing: false, key: contPadKey, octave: contPadOctave)
        padTimbreSampler.sendMIDIEvent(0xB0, data1: 123, data2: 0)
        padTimbreSampler.sendMIDIEvent(0xB0, data1: 120, data2: 0)
    }

    private func stopCustomPadTimbreSound() {
        if let n = activePadSamplerNote {
            padTimbreSampler.stopNote(n, onChannel: 0)
            activePadSamplerNote = nil
        }
        padTimbreSampler.sendMIDIEvent(0xB0, data1: 123, data2: 0)
    }

    func loadPadTimbre(kind: String, name: String, path: String?, base64: String?) throws -> [String: Any] {
        stopCustomPadTimbreSound()
        dsp.setContinuousPadPlaying(false, key: 0, octave: 0)

        if kind == "native" {
            dsp.clearContinuousPadAudioSamples()
            padTimbreKind = .nativeDSP
            if contPadPlaying {
                updateContinuousPad(playing: true, key: contPadKey, octave: contPadOctave)
            }
            return ["kind": "native", "name": "Pad Nativo"]
        }

        if kind == "sf2" {
            dsp.clearContinuousPadAudioSamples()
            let resolvedURL: URL
            if let path = path, FileManager.default.fileExists(atPath: path) {
                resolvedURL = URL(fileURLWithPath: path)
            } else if let base64 = base64, let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
                let padsDir = convertedCacheURL.appendingPathComponent("Pads", isDirectory: true)
                try? FileManager.default.createDirectory(at: padsDir, withIntermediateDirectories: true)
                let safe = name.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
                let dest = padsDir.appendingPathComponent(safe.hasSuffix(".sf2") ? safe : "\(safe).sf2")
                try data.write(to: dest, options: .atomic)
                resolvedURL = dest
            } else {
                throw NSError(domain: "WorkestraPiano", code: 20, userInfo: [NSLocalizedDescriptionKey: "Arquivo SoundFont do pad não encontrado."])
            }
            do {
                try padTimbreSampler.loadSoundBankInstrument(at: resolvedURL, program: 0, bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: 0)
            } catch {
                try padTimbreSampler.loadSoundBankInstrument(at: resolvedURL, program: 0, bankMSB: UInt8(kAUSampler_DefaultPercussionBankMSB), bankLSB: 0)
            }
            padTimbreKind = .samplerSF2
            if contPadPlaying {
                updateContinuousPad(playing: true, key: contPadKey, octave: contPadOctave)
            }
            return ["kind": "sf2", "name": name, "path": resolvedURL.path]
        }

        let url = try resolvePadURL(name: name, path: path, base64: base64)
        let (buf, _) = try decodeAudioToEngineBuffer(url: url)
        guard let chData = buf.floatChannelData, buf.frameLength > 0 else {
            throw NSError(domain: "WorkestraPiano", code: 21, userInfo: [NSLocalizedDescriptionKey: "Buffer de áudio do pad vazio."])
        }
        let ch0 = chData[0]
        let ch1 = buf.format.channelCount >= 2 ? chData[1] : chData[0]
        dsp.setContinuousPadAudioSamplesLeft(ch0, right: ch1, frameCount: Int32(buf.frameLength), sampleRate: buf.format.sampleRate)
        padTimbreKind = .audioLoop
        if contPadPlaying {
            updateContinuousPad(playing: true, key: contPadKey, octave: contPadOctave)
        }
        return ["kind": "audio", "name": name, "path": url.path]
    }

    func updateContinuousPad(playing: Bool, key: Int, octave: Int) {
        let prevPlaying = contPadPlaying
        contPadPlaying = playing
        contPadKey = max(0, min(11, key))
        contPadOctave = (octave != 0) ? 1 : 0

        if contPadPlaying && !engine.isRunning {
            _ = ensureAudioEngineRunning()
        }

        switch padTimbreKind {
        case .nativeDSP, .audioLoop:
            stopCustomPadTimbreSound()
            dsp.setContinuousPadPlaying(contPadPlaying, key: Int32(contPadKey), octave: Int32(contPadOctave))
        case .samplerSF2:
            dsp.setContinuousPadPlaying(false, key: 0, octave: 0)
            let targetNote = UInt8(max(0, min(127, 48 + contPadKey + contPadOctave * 12)))
            if !contPadPlaying {
                if let n = activePadSamplerNote {
                    padTimbreSampler.stopNote(n, onChannel: 0)
                    activePadSamplerNote = nil
                }
            } else if !prevPlaying || activePadSamplerNote != targetNote {
                if let old = activePadSamplerNote {
                    padTimbreSampler.stopNote(old, onChannel: 0)
                }
                padTimbreSampler.startNote(targetNote, withVelocity: 100, onChannel: 0)
                activePadSamplerNote = targetNote
            }
        }
    }

    func previewPadSample(name: String, path: String?, base64: String?) throws {
        let url = try resolvePadURL(name: name, path: path, base64: base64)
        let (buf, _) = try decodeAudioToEngineBuffer(url: url)
        padPreviewPlayer.stop()
        if !engine.isRunning { _ = ensureAudioEngineRunning() }
        padPreviewPlayer.scheduleBuffer(buf, at: nil, options: [], completionHandler: nil)
        padPreviewPlayer.play()
    }

    func readFileSlice(path: String, start: Int, end: Int) throws -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        if start > 0 {
            try fh.seek(toOffset: UInt64(start))
        }
        let data: Data
        if end > start {
            data = try fh.read(upToCount: end - start) ?? Data()
        } else {
            data = try fh.readToEnd() ?? Data()
        }
        return ["base64": data.base64EncodedString()]
    }

    private func loadSoundFont(section: String, layer: String, name: String, path: String?, base64: String?, bank: Int, preset: Int) throws -> [String: Any] {
        let resolvedURL: URL
        if let path = path, FileManager.default.fileExists(atPath: path) {
            resolvedURL = URL(fileURLWithPath: path)
        } else if let base64 = base64, let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
            let safeName = name.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
            let dest = convertedCacheURL.appendingPathComponent(safeName.hasSuffix(".sf2") ? safeName : "\(safeName).sf2")
            try data.write(to: dest, options: .atomic)
            resolvedURL = dest
        } else {
            throw NSError(domain: "WorkestraPiano", code: 2, userInfo: [NSLocalizedDescriptionKey: "Arquivo SoundFont não encontrado: \(name)"])
        }

        guard let sampler = samplerNode(section: section, layer: layer) else {
            throw NSError(domain: "WorkestraPiano", code: 3, userInfo: [NSLocalizedDescriptionKey: "Slot de sampler inválido"])
        }

        if !engine.isRunning { _ = ensureAudioEngineRunning() }

        let bankMSB: UInt8 = (bank == 128) ? UInt8(kAUSampler_DefaultPercussionBankMSB) : UInt8(kAUSampler_DefaultMelodicBankMSB)
        let bankLSB: UInt8 = UInt8(max(0, min(127, bank & 0x7F)))
        let prog: UInt8 = UInt8(max(0, min(127, preset & 0x7F)))

        sampler.overallGain = 0.0
        do {
            try sampler.loadSoundBankInstrument(at: resolvedURL, program: prog, bankMSB: bankMSB, bankLSB: bankLSB)
        } catch {
            do {
                try sampler.loadSoundBankInstrument(at: resolvedURL, program: prog, bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: 0)
            } catch {
                try sampler.loadSoundBankInstrument(at: resolvedURL, program: 0, bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: 0)
            }
        }

        let key = "\(section):\(layer)"
        var st = samplerStates[key] ?? LoadedSamplerState()
        st.url = resolvedURL
        st.bank = bank
        st.preset = preset
        st.active = true
        samplerStates[key] = st
        updateSectionGains()

        return [
            "path": resolvedURL.path,
            "bank": bank,
            "preset": preset
        ]
    }

    private func updateSectionGains() {
        let layerGain: (String, String) -> Float = { sec, L in
            let lvl = self.layerRouting[sec]?[L]?.level ?? 0.8
            return pow(lvl / 0.8, 2)
        }
        let pGainA = (sectionOn["piano"] == true && layerRouting["piano"]?["A"]?.on == true && samplerStates["piano:A"]?.active == true)
            ? layerGain("piano", "A") * (sectionLevels["piano"] ?? 0.85) : 0.0
        let pGainB = (sectionOn["piano"] == true && layerRouting["piano"]?["B"]?.on == true && samplerStates["piano:B"]?.active == true)
            ? layerGain("piano", "B") * (sectionLevels["piano"] ?? 0.85) : 0.0
        pianoGainA.outputVolume = pGainA
        pianoGainB.outputVolume = pGainB

        let sGainA = (sectionOn["strings"] == true && layerRouting["strings"]?["A"]?.on == true && samplerStates["strings:A"]?.active == true)
            ? layerGain("strings", "A") * (sectionLevels["strings"] ?? 0.85) * 0.7 : 0.0
        let sGainB = (sectionOn["strings"] == true && layerRouting["strings"]?["B"]?.on == true && samplerStates["strings:B"]?.active == true)
            ? layerGain("strings", "B") * (sectionLevels["strings"] ?? 0.85) * 0.7 : 0.0
        stringsGainA.outputVolume = sGainA
        stringsGainB.outputVolume = sGainB

        let synSampleVol = (sectionOn["synth"] == true && layerRouting["synth"]?["A"]?.on == true && synthIsSample)
            ? layerGain("synth", "A") * (sectionLevels["synth"] ?? 0.85) * 0.7 : 0.0
        synthSampleGain.outputVolume = synSampleVol
    }

    // MARK: - Unified JS Message Router

    func handleRequest(type: String, payload: [String: Any]) throws -> [String: Any] {
        switch type {
        case "getAudioMidiState":
            return getAudioMidiState()
        case "rescanMidi":
            return rescanMidi()
        case "setAudioDevice":
            return setAudioDevice(uid: payload["deviceId"] as? String ?? "default")
        case "setSampleRate":
            let sr = (payload["sampleRate"] as? NSNumber)?.doubleValue ?? 44100.0
            return setSampleRate(sr)
        case "setBufferSamples":
            return setBufferSamples((payload["samples"] as? NSNumber)?.intValue ?? 256)
        case "restartAudioEngine":
            return restartAudioEngine()
        case "getLocalLibrary":
            return getLocalLibrary()
        case "checkCachedSf2":
            return checkCachedSf2(key: payload["key"] as? String ?? "")
        case "cacheConvertedSf2":
            return try cacheConvertedSf2(
                name: payload["name"] as? String ?? "sound.sf2",
                key: payload["key"] as? String ?? "converted",
                base64: payload["base64"] as? String ?? ""
            )
        case "loadPadSample":
            return try audioQueue.sync {
                return try loadPadSample(
                    index: (payload["index"] as? NSNumber)?.intValue ?? 0,
                    name: payload["name"] as? String ?? "pad.wav",
                    path: payload["path"] as? String,
                    base64: payload["base64"] as? String
                )
            }
        case "loadPadTimbre":
            return try audioQueue.sync {
                return try loadPadTimbre(
                    kind: payload["kind"] as? String ?? "native",
                    name: payload["name"] as? String ?? "Pad Nativo",
                    path: payload["path"] as? String,
                    base64: payload["base64"] as? String
                )
            }
        case "previewPad":
            try audioQueue.sync {
                try previewPadSample(
                    name: payload["name"] as? String ?? "pad.wav",
                    path: payload["path"] as? String,
                    base64: payload["base64"] as? String
                )
            }
            return [:]
        case "readFileSlice":
            return try readFileSlice(
                path: payload["path"] as? String ?? "",
                start: (payload["start"] as? NSNumber)?.intValue ?? 0,
                end: (payload["end"] as? NSNumber)?.intValue ?? -1
            )
        case "loadSound":
            return try audioQueue.sync {
                return try loadSoundFont(
                    section: payload["section"] as? String ?? "piano",
                    layer: payload["layer"] as? String ?? "A",
                    name: payload["name"] as? String ?? "sound.sf2",
                    path: payload["path"] as? String,
                    base64: payload["base64"] as? String,
                    bank: (payload["bank"] as? NSNumber)?.intValue ?? 0,
                    preset: (payload["preset"] as? NSNumber)?.intValue ?? 0
                )
            }
        default:
            handleFireAndForget(type: type, payload: payload)
            return [:]
        }
    }

    func handleFireAndForget(type: String, payload: [String: Any]) {
        audioQueue.async {
            switch type {
            case "setMidiConfig":
                self.stateLock.lock()
                self.midiInputFilter = payload["inputId"] as? String ?? "all"
                if let ids = payload["enabledInputIds"] as? [String] {
                    self.enabledMidiInputIDs = Set(ids)
                } else {
                    self.enabledMidiInputIDs = nil
                }
                self.midiChannelFilter = payload["channel"] as? String ?? "all"
                self.midiOutputId = payload["outputId"] as? String ?? "none"
                self.midiThru = payload["thru"] as? Bool ?? false
                self.stateLock.unlock()

            case "testChime":
                _ = self.ensureAudioEngineRunning()
                self.dsp.triggerTestChime()

            case "playPad":
                self.playPadSample(index: (payload["index"] as? NSNumber)?.intValue ?? 0, loop: payload["loop"] as? Bool ?? false)

            case "stopPad":
                self.stopPadSample(index: (payload["index"] as? NSNumber)?.intValue ?? 0)

            case "stopAllPads":
                self.stopAllPads()

            case "continuousPad":
                let playing = payload["playing"] as? Bool ?? false
                let key = (payload["key"] as? NSNumber)?.intValue ?? 0
                let octave = (payload["octave"] as? NSNumber)?.intValue ?? 0
                self.updateContinuousPad(playing: playing, key: key, octave: octave)

            case "padTimbreNote":
                let note = UInt8(max(0, min(127, (payload["note"] as? NSNumber)?.intValue ?? 60)))
                let on = payload["on"] as? Bool ?? false
                if self.padTimbreKind == .samplerSF2 {
                    if on {
                        if !self.engine.isRunning { _ = self.ensureAudioEngineRunning() }
                        let vel = UInt8(max(1, min(127, (payload["vel"] as? NSNumber)?.intValue ?? 100)))
                        self.padTimbreSampler.startNote(note, withVelocity: vel, onChannel: 0)
                    } else {
                        self.padTimbreSampler.stopNote(note, onChannel: 0)
                    }
                }

            case "stopPadPreview":
                self.padPreviewPlayer.stop()

            case "unloadSound":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                self.allNotesOff(section: sec, layer: layer)
                var st = self.samplerStates["\(sec):\(layer)"] ?? LoadedSamplerState()
                st.url = nil
                self.samplerStates["\(sec):\(layer)"] = st

            case "selectPreset":
                let sec = payload["section"] as? String ?? "synth"
                let layer = payload["layer"] as? String ?? "A"
                let bank = (payload["bank"] as? NSNumber)?.intValue ?? 0
                let preset = (payload["preset"] as? NSNumber)?.intValue ?? 0
                if let url = self.samplerStates["\(sec):\(layer)"]?.url {
                    _ = try? self.loadSoundFont(section: sec, layer: layer, name: url.lastPathComponent, path: url.path, base64: nil, bank: bank, preset: preset)
                }

            case "sectionActive":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                let on = payload["on"] as? Bool ?? true
                var st = self.samplerStates["\(sec):\(layer)"] ?? LoadedSamplerState()
                st.active = on
                self.samplerStates["\(sec):\(layer)"] = st
                if !on { self.allNotesOff(section: sec, layer: layer) }
                self.updateSectionGains()

            case "sectionOn":
                let sec = payload["section"] as? String ?? "piano"
                let on = payload["on"] as? Bool ?? false
                self.sectionOn[sec] = on
                if !on { self.allNotesOff(section: sec, layer: nil) }
                self.updateSectionGains()

            case "sectionOctave":
                let sec = payload["section"] as? String ?? "piano"
                self.sectionOctave[sec] = (payload["octave"] as? NSNumber)?.intValue ?? 0

            case "transpose":
                self.transpose = (payload["value"] as? NSNumber)?.intValue ?? 0

            case "split":
                self.splitNote = (payload["note"] as? NSNumber)?.intValue ?? 60

            case "routing":
                if let curve = (payload["curve"] as? NSNumber)?.doubleValue { self.velCurve = curve }
                if let direct = payload["directMidi"] as? Bool {
                    self.stateLock.lock()
                    self.directMidi = direct
                    self.stateLock.unlock()
                }

            case "layer":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                if let patch = payload["patch"] as? [String: Any] {
                    var lr = self.layerRouting[sec]?[layer] ?? LayerRouting(on: true)
                    if let on = patch["on"] as? Bool { lr.on = on }
                    if let lvl = (patch["level"] as? NSNumber)?.doubleValue {
                        lr.level = Float(max(0.0, min(1.0, lvl)))
                        self.dsp.setLayerLevel(sec, layer: layer, value: lr.level)
                    }
                    if let oct = (patch["octave"] as? NSNumber)?.intValue { lr.octave = oct }
                    if let zone = patch["zone"] as? String { lr.zone = zone }
                    self.layerRouting[sec]?[layer] = lr
                    self.updateSectionGains()
                }

            case "noteOn":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                let note = (payload["note"] as? NSNumber)?.intValue ?? 60
                let vel = (payload["vel"] as? NSNumber)?.intValue ?? 100
                let isSample = payload["sample"] as? Bool ?? false
                self.triggerSectionNoteOn(section: sec, layer: layer, note: note, vel: vel, isSample: isSample)

            case "noteOff":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                let note = (payload["note"] as? NSNumber)?.intValue ?? 60
                self.triggerSectionNoteOff(section: sec, layer: layer, note: note)

            case "sustain":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                let down = payload["down"] as? Bool ?? false
                self.setSustain(section: sec, layer: layer, down: down)

            case "pitchBend":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                self.setPitchBend(section: sec, layer: layer, raw: (payload["raw"] as? NSNumber)?.intValue, semis: (payload["semis"] as? NSNumber)?.doubleValue)

            case "modWheel":
                let sec = payload["section"] as? String ?? "piano"
                let layer = payload["layer"] as? String ?? "A"
                self.setModWheel(section: sec, layer: layer, value: (payload["value"] as? NSNumber)?.doubleValue ?? 0.0)

            case "allOff":
                self.allNotesOff(section: payload["section"] as? String ?? "piano", layer: payload["layer"] as? String)

            case "synthParam":
                let layerStr = payload["layer"] as? String ?? "A"
                let param = payload["param"] as? String ?? ""
                let numVal = (payload["value"] as? NSNumber)?.doubleValue ?? 0.0
                let strVal = payload["value"] as? String
                if layerStr == "A" && param == "osc", let sv = strVal {
                    self.synthIsSample = (sv == "sample")
                    self.updateSectionGains()
                }
                self.dsp.setSynthLayer(layerStr == "B" ? 1 : 0, param: param, numberValue: numVal, stringValue: strVal)

            case "organ":
                let action = payload["action"] as? String ?? ""
                switch action {
                case "bar":
                    self.dsp.setOrganBar(
                        Int32((payload["manual"] as? NSNumber)?.intValue ?? 0),
                        index: Int32((payload["index"] as? NSNumber)?.intValue ?? 0),
                        level: Int32((payload["level"] as? NSNumber)?.intValue ?? 0)
                    )
                case "model":
                    self.dsp.setOrganModel(Int32((payload["manual"] as? NSNumber)?.intValue ?? 0), model: payload["model"] as? String ?? "b3")
                case "perc":
                    if let p = payload["perc"] as? [String: Any] {
                        self.dsp.setOrganPercOn(p["on"] as? Bool ?? false, third: p["third"] as? Bool ?? false, fast: p["fast"] as? Bool ?? false)
                    }
                case "vib":
                    self.dsp.setOrganVibMode(Int32((payload["mode"] as? NSNumber)?.intValue ?? 0))
                case "drive":
                    self.dsp.setOrganDrive((payload["value"] as? NSNumber)?.doubleValue ?? 0.0)
                case "rotary":
                    self.dsp.setOrganRotaryMode(Int32(payload["mode"] as? Int ?? 0))
                default:
                    break
                }

            case "fx":
                self.applyFX(payload: payload)

            default:
                break
            }
        }
    }

    private func applyFX(payload: [String: Any]) {
        let param = payload["param"] as? String ?? ""
        let val = (payload["value"] as? NSNumber)?.doubleValue ?? 0.0
        switch param {
        case "master":
            masterVolume = Float(val * val * 1.2)
            engine.mainMixerNode.outputVolume = masterVolume
        case "bass":
            masterEQ.bands[0].gain = Float((val - 0.5) * 30.0)
            masterEQ.bypass = abs(masterEQ.bands[0].gain) < 0.05 && abs(masterEQ.bands[1].gain) < 0.05 && abs(masterEQ.bands[2].gain) < 0.05
        case "mid":
            masterEQ.bands[1].gain = Float((val - 0.5) * 24.0)
            masterEQ.bypass = abs(masterEQ.bands[0].gain) < 0.05 && abs(masterEQ.bands[1].gain) < 0.05 && abs(masterEQ.bands[2].gain) < 0.05
        case "treble":
            masterEQ.bands[2].gain = Float((val - 0.5) * 30.0)
            masterEQ.bypass = abs(masterEQ.bands[0].gain) < 0.05 && abs(masterEQ.bands[1].gain) < 0.05 && abs(masterEQ.bands[2].gain) < 0.05
        case "delay":
            let wet = Float(max(0.0, min(100.0, val * 70.0)))
            delayUnit.wetDryMix = wet
            delayUnit.bypass = wet <= 0.01
        case "delayTime":
            delayUnit.delayTime = 0.08 + val * 0.92
        case "delayFeedback":
            delayUnit.feedback = Float(max(-100.0, min(95.0, val * 88.0)))
        case "delayMode":
            let m = payload["value"] as? String ?? "pingpong"
            delayUnit.lowPassCutoff = (m == "tape") ? 2500 : 3800
        case "reverb":
            let wet = Float(max(0.0, min(100.0, val * 65.0)))
            reverbUnit.wetDryMix = wet
            reverbUnit.bypass = wet <= 0.01
        case "reverbType":
            let t = payload["value"] as? String ?? "stage"
            switch t {
            case "room": reverbUnit.loadFactoryPreset(.smallRoom)
            case "hall": reverbUnit.loadFactoryPreset(.largeHall)
            case "plate": reverbUnit.loadFactoryPreset(.plate)
            case "spring": reverbUnit.loadFactoryPreset(.mediumRoom)
            default: reverbUnit.loadFactoryPreset(.mediumHall)
            }
        case "reverbTone":
            // AVAudioUnitReverb exposes wetDryMix; tone shaping via master highShelf tint if desired
            break
        case "stringsCutoff":
            let layer = payload["layer"] as? String ?? "A"
            let hz = Float(min(20000.0, 80.0 * pow(2.0, val * 8.0)))
            if layer == "B" {
                stringsFilterB.bands[0].frequency = hz
                stringsFilterB.bypass = hz >= 19500.0
            } else {
                stringsFilterA.bands[0].frequency = hz
                stringsFilterA.bypass = hz >= 19500.0
            }
        case "timbre":
            let mode = Int(val)
            let band = pianoTimbreEQ.bands[0]
            switch mode {
            case 1:
                band.filterType = .highShelf
                band.frequency = 2500
                band.gain = -9
                band.bypass = false
                pianoTimbreEQ.bypass = false
            case 2:
                band.filterType = .parametric
                band.frequency = 1600
                band.bandwidth = 1.1
                band.gain = 5
                band.bypass = false
                pianoTimbreEQ.bypass = false
            case 3:
                band.filterType = .highShelf
                band.frequency = 3800
                band.gain = 7
                band.bypass = false
                pianoTimbreEQ.bypass = false
            default:
                band.bypass = true
                pianoTimbreEQ.bypass = true
            }
        case "sectionLevel":
            let sec = payload["section"] as? String ?? "piano"
            let g = Float(val * val * 1.4)
            sectionLevels[sec] = g
            dsp.setSectionLevel(sec, value: Float(val))
            updateSectionGains()
        case "perfMode":
            let studio = (payload["value"] as? String) == "studio"
            dsp.setPerfModeStudio(studio)
        default:
            break
        }
    }
}
