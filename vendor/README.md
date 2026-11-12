# Dependências externas do LabPiano

Esta pasta contém bibliotecas de terceiros utilizadas pelo LabPiano. Manter dependências externas separadas dos fontes autorais do aplicativo.

## FluidSynth 2.4.6

- `libfluidsynth-2.4.6-with-libsndfile.js`
- `LICENSE.fluidsynth.txt`

A variante `with-libsndfile` foi escolhida para este projeto. Ela não é intercambiável automaticamente com `libfluidsynth-2.4.6.js`.

Origem: https://github.com/jet2jet/js-synthesizer

## js-synthesizer 1.13.0

- `js-synthesizer.min.js` — biblioteca principal.
- `js-synthesizer.worklet.min.js` — código do AudioWorklet; registra o processador `js-synthesizer`.
- `js-synthesizer.txt` — licença BSD 3-Clause do projeto.

Os dois arquivos JavaScript foram conferidos no repositório e seus cabeçalhos declaram a versão 1.13.0.

Origem: https://github.com/jet2jet/js-synthesizer

## Observações de integração

- Conferir no HTML o caminho de cada script.
- O Worklet precisa ser carregado pelo mecanismo de AudioWorklet com o caminho correto.
- A presença dos arquivos no GitHub não significa que a integração do áudio já foi testada.
- Não remover nem substituir versões sem testar a compatibilidade com o código do LabPiano.
