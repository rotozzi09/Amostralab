# Notas técnicas reunidas — LabPiano

Atualizado em 2026-11-05. Este documento preserva decisões, descrições e fragmentos conhecidos durante a recuperação. Não é código executável e não substitui os fontes originais.

## Escopo

Recuperar exclusivamente o LabPiano/AmostraLab. Manter dependências de terceiros em `vendor/` e fontes autorais em diretórios próprios (`js/`, `css/` etc.) quando forem recuperados.

## Motor de áudio

- FluidSynth 2.4.6 compilado para WebAssembly.
- Dependência escolhida: `libfluidsynth-2.4.6-with-libsndfile.js`.
- Integração: js-synthesizer 1.13.0.
- Processamento de áudio via AudioWorklet; o arquivo Worklet registra o processador `js-synthesizer`.
- A simples presença das dependências não comprova que a inicialização do motor, o carregamento do banco SF2 ou o áudio estejam funcionando. Isso requer teste no navegador.

## Camadas e instrumentos

- O projeto foi descrito com Layer A e Layer B.
- Cada Layer utiliza uma instância FluidSynth independente e seu próprio SF2.
- A Layer B deve ser criada somente quando receber o primeiro SF2.
- Foi observado/relatado que trocar o SF2 de uma instância já ativa pode congelar ou interromper o áudio. Preservar essa observação como risco a investigar, não como comportamento inevitável confirmado em todos os ambientes.

## Arquivos e formatos

- Foram mencionados fluxos de importação/conversão de arquivos `.npno` e `.nsmp4` para SF2.
- Foi mencionada a possibilidade de carregar bibliotecas/timbres de uma pasta externa, aberta pelo usuário por meio de um botão.
- Planejamento futuro: suporte a WAV para um canal de pads contínuos e para drum pad.
- Não implementar conversores sem recuperar ou especificar os formatos e validar os resultados.

## Painel e controles

Foi compartilhado um trecho de código de controles cujo início conhecido é:

```js
// Controles do painel: knobs com anel de LEDs, faders, drawbars, seletores com LED,
// displays de 7 segmentos, pitch stick / mod wheel e o teclado de 88 teclas.

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function dragValue(el, get, setv, sensitivity = 160) {
```

O trecho acima é apenas o início conhecido; não completar por suposição. Os controles mencionados incluem knobs, faders, drawbars, seletores com LED, displays de 7 segmentos, pitch stick, mod wheel e teclado de 88 teclas.

## Aparências / layouts

### Layout vermelho

Descrição recebida: painel inspirado em teclados de palco vermelhos, paleta incluindo:
- vermelho principal `#b8191a`
- vermelho escuro `#8c1a11`
- vermelho claro citado como `#d42a22`
- cinzas estilo Material e tipografia Helvetica.

### Layout Fantom / Workstation

Descrição recebida para `html[data-skin="fantom"]`:
- workstation preta;
- tela colorida central com lista de sons;
- knobs com anel ciano;
- painel do synth em azul-ardósia;
- pads rosa em grade 4×4;
- controles compartilhados com outro layout, com os pads como bloco próprio.

Essas descrições servem como referência visual para reconstrução, não como CSS completo.

## Plataforma

Objetivo futuro declarado: funcionar também em Windows e macOS. Priorizar primeiro a versão web estável e depois validar empacotamento/integração desktop.

## Regras para continuar a recuperação

1. Preservar blocos literais exatamente como recebidos.
2. Identificar o nome e o caminho do arquivo antes de salvar.
3. Se o código vier em partes, manter a ordem e confirmar que todas as partes chegaram.
4. Não criar arquivos vazios, trechos fictícios ou stubs como se fossem recuperação.
5. Depois de salvar, conferir o arquivo no GitHub e validar sintaxe/referências.
6. Marcar como funcional somente após teste real no navegador.
