# AmostraLab / LabPiano — estado da recuperação

Atualizado em 2026-11-05.

## Objetivo
Recuperar e organizar exclusivamente o projeto LabPiano/AmostraLab, preservando os arquivos originais e evitando substituir código por versões reconstruídas ou incompletas.

## Estado confirmado no GitHub

A pasta `vendor/` foi conferida diretamente no repositório. Estão presentes:

- `libfluidsynth-2.4.6-with-libsndfile.js` — FluidSynth 2.4.6, arquivo com 2.371.527 bytes.
- `LICENSE.fluidsynth.txt` — licença LGPL 2.1 do FluidSynth.
- `js-synthesizer.min.js` — js-synthesizer 1.13.0, 32.301 bytes.
- `js-synthesizer.worklet.min.js` — js-synthesizer 1.13.0, 30.329 bytes.
- `js-synthesizer.txt` — licença BSD 3-Clause do js-synthesizer.
- `README.md` — documentação da pasta de dependências.

Os dois arquivos minificados foram lidos e conferidos: ambos declaram a versão 1.13.0. O Worklet registra o processador `js-synthesizer`.

## Arquivos identificados no HTML do projeto

O HTML recuperado referencia estes caminhos:

- `js/app.js`
- `js/visuals.js`
- `vendor/js-synthesizer.min.js`
- `css/app.css`
- `css/native.css`
- `css/fantom.css`

A biblioteca `vendor/js-synthesizer.min.js` já está no repositório. Os demais fontes autorais ainda precisam ser recuperados e validados.

## Estado do código autoral recuperado nas conversas

- `app.js`: há descrições e trechos parciais da lógica principal, incluindo FluidSynth para Piano/Synth, conversão/importação de arquivos `.npno` e `.nsmp4` para SF2, carregamento de arquivos externos e referência a `access.js`. Não há conteúdo integral validado para salvar como arquivo funcional.
- `audio.js`: foi solicitado durante a recuperação, mas seu conteúdo integral não está disponível no material consolidado.
- `visuals.js`: caminho identificado no HTML; conteúdo integral não localizado.
- `controls.js`: foi compartilhado um trecho iniciado por `clamp01` e `dragValue`, com comentários sobre knobs, faders, drawbars, seletores, displays, pitch/mod e teclado de 88 teclas. O trecho não é suficiente para reconstruir o arquivo completo.
- CSS: foram compartilhados trechos e descrições dos layouts vermelho e Fantom/Workstation, mas os arquivos completos `app.css`, `native.css` e `fantom.css` ainda não estão validados no repositório.

Não criar arquivos vazios, stubs ou código inventado para simular recuperação. Quando cada bloco literal for recuperado, salvá-lo em seu caminho correto e validar antes de marcar como concluído.

## Arquitetura e decisões já descritas

- FluidSynth 2.4.6 em WebAssembly.
- Integração com js-synthesizer 1.13.0 e AudioWorklet.
- Layers A e B com instâncias FluidSynth independentes e seus próprios arquivos SF2.
- Layer B criada somente quando recebe o primeiro SF2.
- Alterar o SF2 de uma instância ativa pode causar congelamento/instabilidade de áudio; considerar isso nos testes e na implementação.
- O carregamento de bibliotecas e timbres externos deve ocorrer por uma pasta externa aberta por um botão.
- Planejamento futuro para arquivos WAV, um canal de pads contínuos e drum pad.
- Meta futura de compatibilidade com Windows e macOS.

Esses itens são decisões e descrições técnicas, não substituem o código-fonte.

## Próximos passos

1. Recuperar os arquivos autorais literais das conversas anteriores ou de cópias locais.
2. Salvar primeiro os arquivos HTML/JS/CSS em seus caminhos reais, sem inventar conteúdo.
3. Conferir referências entre scripts, caminhos das dependências e carregamento do AudioWorklet.
4. Testar áudio, carregamento de SF2 e comportamento das Layers A/B no navegador.
5. Só então avançar para WAV, pads e compatibilidade desktop.

Consulte também [recuperacao/INVENTARIO.md](recuperacao/INVENTARIO.md) e [vendor/README.md](vendor/README.md).
