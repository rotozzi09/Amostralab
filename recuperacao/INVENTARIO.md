# Inventário de recuperação — LabPiano

Atualizado em 2026-11-05.

Este inventário separa código-fonte autoral do LabPiano, dependências externas e descrições técnicas. Nenhum arquivo JavaScript incompleto deve ser apresentado como funcional.

## 1. Código autoral do LabPiano

| Caminho identificado | Evidência disponível | Situação |
|---|---|---|
| `js/app.js` | Descrições da lógica principal: FluidSynth, importação/conversão de `.npno` e `.nsmp4` para SF2, carregamento externo e referência a `access.js` | Código integral não recuperado/validado |
| `js/audio.js` | Nome solicitado durante a recuperação | Conteúdo integral não localizado |
| `js/visuals.js` | Referência no HTML | Conteúdo integral não localizado |
| `js/controls.js` | Trecho com `clamp01` e `dragValue`; comentários citam knobs, faders, drawbars, seletores, displays, pitch/mod e teclado de 88 teclas | Fragmento insuficiente para formar arquivo completo |
| `js/piano.js`, `sampler.js`, `reader.js`, `sf2reader.js`, `workstation.js`, `fantom.js`, `icons.js`, `mobile.js`, `midilearn.js`, `access.js` | Nomes/responsabilidades mencionados durante a recuperação | Conteúdo integral não localizado |
| `css/app.css`, `css/native.css`, `css/fantom.css` | Referências no HTML; trechos/descrições dos estilos vermelho e Fantom/Workstation | Arquivos completos não validados |

**Regra de recuperação:** não criar arquivos vazios, stubs ou código inventado para simular recuperação. Salvar os blocos literais nos caminhos corretos e validar antes de marcar como recuperados.

## 2. Arquitetura já descrita

- FluidSynth 2.4.6 em WebAssembly.
- js-synthesizer 1.13.0 com AudioWorklet.
- Layers A e B independentes, cada uma com sua instância FluidSynth e seu próprio SF2.
- Layer B criada somente ao receber o primeiro SF2.
- Foi relatado risco de congelamento/instabilidade ao trocar o SF2 de uma instância ativa.
- Bibliotecas e timbres externos devem ser carregados por uma pasta externa aberta por botão.
- Planejamento futuro: WAV, pads contínuos e drum pad.
- Meta futura: Windows e macOS.

São decisões e descrições de arquitetura, não código-fonte recuperado.

## 3. Dependências externas — conferidas no repositório

Diretório: `vendor/`

| Arquivo | Tamanho confirmado | Situação |
|---|---:|---|
| `libfluidsynth-2.4.6-with-libsndfile.js` | 2.371.527 bytes | Presente no GitHub |
| `LICENSE.fluidsynth.txt` | 26.461 bytes | Presente no GitHub |
| `js-synthesizer.min.js` | 32.301 bytes | Presente; cabeçalho declara versão 1.13.0 |
| `js-synthesizer.worklet.min.js` | 30.329 bytes | Presente; cabeçalho declara versão 1.13.0 |
| `js-synthesizer.txt` | 1.513 bytes | Presente; licença BSD 3-Clause |
| `README.md` | — | Presente |

Os dois arquivos minificados foram lidos no GitHub. O Worklet registra o processador `js-synthesizer`.

Origem upstream do js-synthesizer: https://github.com/jet2jet/js-synthesizer

Origem upstream do FluidSynth incluído: https://raw.githubusercontent.com/jet2jet/js-synthesizer/main/externals/libfluidsynth-2.4.6-with-libsndfile.js

**Atenção:** `libfluidsynth-2.4.6-with-libsndfile.js` e `libfluidsynth-2.4.6.js` são variantes diferentes. Não renomear nem substituir uma pela outra sem validar a configuração.

## 4. Estrutura atual confirmada

```text
AmostraLab/
├── README.md
├── RECUPERACAO.md
├── TESTE-GITHUB-CHATGPT.md
├── recuperacao/
│   └── INVENTARIO.md
└── vendor/
    ├── LICENSE.fluidsynth.txt
    ├── README.md
    ├── js-synthesizer.min.js
    ├── js-synthesizer.txt
    ├── js-synthesizer.worklet.min.js
    └── libfluidsynth-2.4.6-with-libsndfile.js
```

Esta é a árvore verificada no GitHub em 2026-11-05. Ainda não há fontes autorais do LabPiano (`js/` e `css/`) confirmados nessa árvore.

## 5. Próximas etapas

1. Recuperar o conteúdo literal dos arquivos autorais.
2. Criar os arquivos nos caminhos reais e conferir tamanho/conteúdo.
3. Verificar imports, ordem de carregamento e caminho do AudioWorklet.
4. Fazer testes de áudio e de Layers A/B.
5. Planejar WAV/pads e compatibilidade Windows/macOS após estabilizar o núcleo.
