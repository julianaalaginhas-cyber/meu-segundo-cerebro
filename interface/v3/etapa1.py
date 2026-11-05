"""Etapa 1 — Início, navegação (Favoritos), Agenda, captura (QuickAdd), Diário.

Gera interface/v3/pedidos.json com (caminho, acao, conteudo).
- acao "criar": só cria se não existir (nunca sobrescreve)
- acao "substituir": só telas do sistema; o plugin Ponte faz backup antes
"""
import json
import uuid
from pathlib import Path

AQUI = Path(__file__).parent
P = "05 - Sistema/Painéis"
M = "05 - Sistema/Modelos"
CAP = f"{M}/Captura"
AG = "07 - Agenda"
DIA = "01 - Vida/Rotina/Diário"
COMPRAS = "01 - Vida/Casa/Compras"
TREINOS = "01 - Vida/Rotina/Treinos"
PEDIDOS = []


def add(caminho, conteudo=None, acao="criar"):
    PEDIDOS.append({"caminho": caminho, "acao": acao, "conteudo": conteudo})


AVISO = ("> [!sc-aviso-css] ⚠️ O visual está desligado\n"
         "> Configurações → Aparência → Trechos CSS → ative **segundo-cerebro-dashboard**.\n")


def tela(props=""):
    return f"---\ncssclasses:\n  - sc-app\n{props}---\n{AVISO}\n"


def topo(titulo, voltar=None, sub=None):
    partes = [x for x in (voltar, sub) if x]
    return f"> [!sc-topo] {titulo}\n" + (f"> {' · '.join(partes)}\n" if partes else "")


def cartoes(lista, tipo="sc-grade"):
    linhas = [f"> [!{tipo}]"]
    for i, (cor, icone, alvo, rotulo) in enumerate(lista):
        if i:
            linhas.append(">")
        linhas += [f"> > [!sc-c-{cor}] {icone}", f"> > [[{alvo}|{rotulo}]]"]
    return "\n".join(linhas) + "\n"


def emb(base, vista):
    return f"![[{P}/{base}.base#{vista}]]"


def bloco(titulo, base, vista):
    return (titulo, base, vista)


def coluna(*blocos):
    """Uma coluna: callout sc-col com painéis (sc-bloco) empilhados."""
    linhas = ["> > [!sc-col]"]
    for i, (titulo, base, vista) in enumerate(blocos):
        if i:
            linhas.append("> >")
        linhas += [f"> > > [!sc-bloco] {titulo}", f"> > > {emb(base, vista)}"]
    return "\n".join(linhas)


def colunas(*cols, tipo="sc-colunas"):
    linhas = [f"> [!{tipo}]"]
    for i, c in enumerate(cols):
        if i:
            linhas.append(">")
        linhas.append(c if isinstance(c, str) else coluna(c))
    return "\n".join(linhas) + "\n"


VC = "[[🏠 Minha Central|‹ Início]]"
VV = "[[01 - Vida/🏡 Minha Vida|‹ Minha Vida]]"

# =============================================================== FÓRMULAS COMUNS
VENC = ('if(proxima_manutencao, date(proxima_manutencao), if(vencimento, date(vencimento), '
        'if(proxima_dose, date(proxima_dose), if(validade, date(validade), if(proxima_cobranca, date(proxima_cobranca), '
        'if(garantia_ate, date(garantia_ate), if(proxima_revisao, date(proxima_revisao), if(tipo == "processo" && prazo, date(prazo)))))))))')
OQUE = ('if(tipo == "tarefa", "✅ Tarefa", if(tipo == "compromisso", "🗓️ Compromisso", if(tipo == "lembrete", "⏰ Lembrete", '
        'if(proxima_manutencao, "🔧 Manutenção", if(vencimento, "💳 Vencimento", if(proxima_dose, "💉 Dose", '
        'if(validade, "🪪 Validade", if(proxima_cobranca, "🔁 Cobrança", if(garantia_ate, "🛡️ Garantia", '
        'if(proxima_revisao, "📚 Revisão", if(tipo == "processo", "⚖️ Prazo")))))))))))')
AGENDAVEL = 'tipo == "tarefa" || tipo == "compromisso" || tipo == "lembrete"'
QUANDO = f'if({AGENDAVEL}, if(data, date(data), if(prazo, date(prazo))), {VENC})'
ROTULO_DIA = ('formula.quando.format("E") + " · " + formula.quando.format("ddd DD/MM") '
              '+ if(formula.quando == today(), "   ● HOJE", "")')
GRUPO = ('if(!formula.quando, "6 · Sem data", if(formula.quando < today(), "1 · Atrasadas", '
         'if(formula.quando == today(), "2 · Hoje", if(formula.quando == today() + duration("1d"), "3 · Amanhã", '
         'if(formula.quando.format("GGGG-WW") == today().format("GGGG-WW"), "4 · Esta semana", "5 · Mais tarde")))))')
GRUPO_GERAL = ('if(tipo == "projeto", "🚀 Projetos ativos", if(tipo == "lancamento", "💳 Contas a pagar", '
               'if(proxima_manutencao, "🔧 Manutenções", if(proxima_dose || tipo == "saude", "🩺 Saúde e vacinas", '
               'if(validade, "🪪 Documentos", if(proxima_cobranca, "🔁 Assinaturas", if(proxima_revisao, "📚 Revisões", '
               'if(tipo == "processo", "⚖️ Prazos de processos", "⏳ Outros vencimentos"))))))))')
PENDENTE = ['feita != true', 'status != "feita"', 'status != "pago"', 'status != "cancelada"']
SEMANA = 'formula.quando.format("GGGG-WW") == {d}.format("GGGG-WW")'
PROG = ('if(values.length == 0, "Nenhuma tarefa para hoje", '
        '"▓".repeat((values.filter(value == true).length / values.length * 10).round()) + '
        '"░".repeat(10 - (values.filter(value == true).length / values.length * 10).round()) + "   " + '
        '(values.filter(value == true).length / values.length * 100).toFixed(0) + "%  ·  " + '
        'values.filter(value == true).length.toFixed(0) + " de " + values.length.toFixed(0))')


def vista(nome, filtros, colunas_, extra="", ou=None):
    f = "".join(f"        - '{x}'\n" for x in filtros)
    if ou:
        f += "        - or:\n" + "".join(f"            - '{x}'\n" for x in ou)
    c = "".join(f"      - {x}\n" for x in colunas_)
    return f"  - type: table\n    name: \"{nome}\"\n    filters:\n      and:\n{f}    order:\n{c}{larguras(colunas_)}{extra}"


LARGURAS = {"feita": 46, "file.name": 300, "formula.o_que": 150, "formula.quando": 120, "formula.dia": 160,
            "area": 110, "hora": 80, "prioridade": 100, "projeto": 160, "status": 120, "prazo": 110,
            "humor": 130, "energia": 100, "sono": 90, "valor": 100, "vencimento": 110}


def larguras(colunas_):
    itens = [c for c in colunas_ if c in LARGURAS]
    if not itens:
        return ""
    nome = lambda c: c if "." in c else "note." + c
    return "    columnSize:\n" + "".join(f"      {nome(c)}: {LARGURAS[c]}\n" for c in itens)


def agrupar(prop, direcao="ASC"):
    return f"    groupBy:\n      property: {prop}\n      direction: {direcao}\n"


ORDEM_QUANDO = "    sort:\n      - property: formula.quando\n        direction: ASC\n"
TAREFA = 'tipo == "tarefa"'

# =============================================================== Agenda.base
add(f"{P}/Agenda.base", acao="substituir", conteudo=f"""filters:
  and:
    - '!file.inFolder("05 - Sistema")'
formulas:
  quando: '{QUANDO}'
  dia: '{ROTULO_DIA}'
  o_que: '{OQUE}'
  grupo: '{GRUPO}'
  grupo_geral: '{GRUPO_GERAL}'
summaries:
  progresso: '{PROG}'
properties:
  file.name:
    displayName: Item
  feita:
    displayName: "✓"
  formula.quando:
    displayName: Quando
  formula.o_que:
    displayName: Tipo
  formula.dia:
    displayName: Dia
  formula.grupo:
    displayName: Quando
  formula.grupo_geral:
    displayName: O quê
views:
  - type: table
    name: "Hoje (com progresso)"
    filters:
      and:
        - '{TAREFA}'
        - or:
            - 'formula.quando == today()'
            - and:
                - 'formula.quando < today()'
                - 'feita != true'
                - 'status != "feita"'
    order:
      - feita
      - file.name
      - formula.quando
      - area
      - prioridade
{larguras(["feita", "file.name", "formula.quando", "area", "prioridade"])}    sort:
      - property: formula.quando
        direction: ASC
    summaries:
      feita: progresso
  - type: table
    name: "Pendências"
    filters:
      and:
        - 'tipo == "tarefa" || tipo == "compromisso" || tipo == "lembrete"'
        - 'feita != true'
        - 'status != "feita"'
        - 'status != "cancelada"'
    order:
      - feita
      - file.name
      - formula.o_que
      - formula.quando
      - area
{larguras(["feita", "file.name", "formula.o_que", "formula.quando", "area"])}    groupBy:
      property: formula.grupo
      direction: ASC
    sort:
      - property: formula.quando
        direction: ASC
  - type: table
    name: "Visão geral"
    filters:
      or:
        - and:
            - 'tipo == "projeto"'
            - 'status == "ativo" || status == "planejamento" || status == "em andamento"'
        - and:
            - '!({AGENDAVEL})'
            - 'formula.quando'
            - 'formula.quando <= today() + duration("30d")'
            - 'status != "pago"'
            - 'status != "cancelada"'
            - 'status != "concluído"'
    order:
      - file.name
      - formula.quando
      - valor
      - status
{larguras(["file.name", "formula.quando", "valor", "status"])}    groupBy:
      property: formula.grupo_geral
      direction: ASC
    sort:
      - property: formula.quando
        direction: ASC
{vista("Esta semana", [SEMANA.format(d="today()"), 'status != "pago"', 'status != "cancelada"'], ["feita", "file.name", "formula.o_que", "area", "hora"], agrupar("formula.dia") + ORDEM_QUANDO)}
{vista("Semana passada", [SEMANA.format(d='(today() - duration("7d"))'), 'status != "pago"', 'status != "cancelada"'], ["feita", "file.name", "formula.o_que", "area"], agrupar("formula.dia") + ORDEM_QUANDO)}
{vista("Próxima semana", [SEMANA.format(d='(today() + duration("7d"))'), 'status != "pago"', 'status != "cancelada"'], ["feita", "file.name", "formula.o_que", "area", "hora"], agrupar("formula.dia") + ORDEM_QUANDO)}
{vista("Hoje", [TAREFA, 'feita != true', 'status != "feita"', 'formula.quando <= today()'], ["feita", "file.name", "formula.quando", "area", "prioridade"], ORDEM_QUANDO)}
{vista("Todas as pendentes", [TAREFA, 'feita != true', 'status != "feita"'], ["feita", "file.name", "formula.quando", "area", "prioridade", "projeto"], ORDEM_QUANDO)}
{vista("Sem data", [TAREFA, 'feita != true', 'status != "feita"', '!data', '!prazo'], ["feita", "file.name", "area", "prioridade"])}
{vista("Concluídas", [TAREFA], ["feita", "file.name", "formula.quando", "area"], "    limit: 30\n", ou=['feita == true', 'status == "feita"'])}
{vista("Progresso de hoje", [TAREFA, 'formula.quando == today()'], ["feita", "file.name"], "    summaries:\n      feita: progresso\n")}
{vista("Compromissos", ['tipo == "compromisso" || tipo == "lembrete"', 'formula.quando >= today()'], ["file.name", "formula.quando", "hora", "local"], ORDEM_QUANDO)}
{vista("Este mês", ['formula.quando.format("YYYY-MM") == today().format("YYYY-MM")'] + PENDENTE, ["file.name", "formula.o_que", "formula.quando"], agrupar("formula.quando") )}
{vista("Vencimentos", PENDENTE + ['!(' + AGENDAVEL + ')', 'formula.quando <= today() + duration("30d")'], ["file.name", "formula.o_que", "formula.quando"], ORDEM_QUANDO)}
{vista("Contas da semana", ['tipo == "lancamento"', 'natureza == "despesa"', 'status == "pendente"', 'date(vencimento) <= today() + duration("7d")'], ["file.name", "valor", "vencimento"], "    sort:\n      - property: vencimento\n        direction: ASC\n    summaries:\n      valor: Sum\n")}
{vista("Projetos ativos", ['tipo == "projeto"', 'status == "ativo" || status == "planejamento" || status == "em andamento"'], ["file.name", "status", "prazo"])}
""")

# =============================================================== Diário.base (hábitos, humor, gratidão)
add(f"{P}/Diário.base", acao="substituir", conteudo=f"""filters:
  and:
    - 'file.inFolder("{DIA}")'
formulas:
  dia: 'date(file.name)'
properties:
  file.name:
    displayName: Dia
views:
{vista("Hoje", ['formula.dia == today()'], ["file.name", "humor", "energia", "sono"])}
{vista("Esta semana", ['formula.dia.format("GGGG-WW") == today().format("GGGG-WW")'], ["file.name", "humor", "energia", "sono"], "    sort:\n      - property: file.name\n        direction: ASC\n")}
{vista("Histórico", ['formula.dia <= today()'], ["file.name", "humor", "energia", "sono"], "    sort:\n      - property: file.name\n        direction: DESC\n    limit: 60\n")}
""".replace("\\n", "\n"))

# =============================================================== Rotina.base (treinos, compras, documentos, casa)
add(f"{P}/Rotina.base", acao="substituir", conteudo=f"""filters:
  and:
    - '!file.inFolder("05 - Sistema")'
properties:
  file.name:
    displayName: Nota
views:
{vista("Treinos", ['tipo == "treino"'], ["realizado", "file.name", "data", "tipo_treino", "duracao_min"], "    sort:\n      - property: data\n        direction: DESC\n")}
{vista("Treinos da semana", ['tipo == "treino"', 'date(data).format("GGGG-WW") == today().format("GGGG-WW")'], ["realizado", "file.name", "data", "tipo_treino", "duracao_min"], "    summaries:\n      realizado: Checked\n      duracao_min: Sum\n")}
{vista("Equipamentos", ['tipo == "equipamento"'], ["file.name", "ultima_manutencao", "proxima_manutencao", "garantia_ate"], "    sort:\n      - property: proxima_manutencao\n        direction: ASC\n")}
{vista("Documentos", ['tipo == "documento"'], ["file.name", "pessoa", "documento", "validade"])}
""")

# =============================================================== 🏠 Minha Central
def painel(titulo, base, vista):
    return f"> [!sc-bloco] {titulo}\n> {emb(base, vista)}\n"


central = (tela() + topo("🧠 Meu Segundo Cérebro", sub="Minha vida, minhas ideias e meus projetos.") + "\n"
           + cartoes([
               ("rosa", "🏡", "01 - Vida/🏡 Minha Vida", "Minha Vida"),
               ("lilas", "⚖️", "02 - Trabalho/⚖️ Trabalho", "Trabalho"),
               ("pessego", "🚀", "04 - Projetos/🚀 Projetos", "Projetos"),
               ("salvia", "📚", "03 - Conhecimento/📚 Conhecimento", "Conhecimento"),
               ("menta", "💰", "06 - Financeiro/💰 Meu Financeiro", "Financeiro"),
               ("roxo", "📅", "07 - Agenda/📅 Planejamento", "Planejamento"),
               ("coral", "📥", "00 - Entrada/Caixa de Entrada", "Entrada"),
           ]) + "\n"
           + painel("☀️ Hoje", "Agenda", "Hoje (com progresso)") + "\n"
           + painel("📋 Pendências", "Agenda", "Pendências") + "\n"
           + painel("🔁 Hábitos da semana", "Diário", "Esta semana") + "\n"
           + painel("🔭 Visão geral", "Agenda", "Visão geral"))
add("🏠 Minha Central.md", central, "substituir")

# =============================================================== 📅 Planejamento (Agenda)
agenda = (tela() + topo("📅 Agenda", voltar=VC) + "\n"
          + "## 📅 Semana\n" + emb("Agenda", "Esta semana") + "\n\n"
          + "## ✅ Tarefas\n" + emb("Agenda", "Hoje") + "\n\n"
          + "### 📋 Todas as pendentes\n" + emb("Agenda", "Todas as pendentes") + "\n\n"
          + "### 🗂️ Sem data\n" + emb("Agenda", "Sem data") + "\n\n"
          + "### ✔️ Concluídas\n" + emb("Agenda", "Concluídas") + "\n\n"
          + "## 🗓️ Compromissos\n" + emb("Agenda", "Compromissos") + "\n\n"
          + "## 🗓️ Este mês\n" + emb("Agenda", "Este mês") + "\n\n"
          + "## ⏳ Vencimentos\n" + emb("Agenda", "Vencimentos") + "\n")
add("07 - Agenda/📅 Planejamento.md", agenda, "substituir")

# =============================================================== 🏡 Minha Vida (v2, agora com Treinos e Compras)
V = "01 - Vida"
add(f"{V}/🏡 Minha Vida.md", tela() + topo("🏡 Minha Vida", voltar=VC) + "\n" + cartoes([
    ("rosa", "👪", f"{V}/Família/Família", "Família"),
    ("ceu", "👦", f"{V}/Família/Nicolas", "Nicolas"),
    ("pessego", "🛒", f"{V}/Casa/🛒 Casa e Compras", "Casa e Compras"),
    ("salvia", "🐾", f"{V}/Pets/Pets", "Pets"),
    ("menta", "🩺", f"{V}/Saúde/Saúde", "Saúde"),
    ("lilas", "✈️", f"{V}/Viagens/Viagens", "Viagens"),
    ("coral", "🏋️", f"{V}/Rotina/🏋️ Treinos", "Treinos"),
    ("amarelo", "😊", f"{V}/Rotina/😊 Humor e Gratidão", "Humor e Gratidão"),
    ("roxo", "🔁", f"{V}/Rotina/🔁 Hábitos", "Hábitos"),
    ("ceu", "📁", f"{V}/📁 Documentos", "Documentos"),
], "sc-grade-p") + "\n## ⏳ Próximas datas\n" + f"![[{P}/Telas.base#Vida - próximas datas]]\n", "substituir")

# =============================================================== telas novas (compactas)
add(f"{V}/Rotina/🔁 Hábitos.md", tela() + topo("🔁 Hábitos", voltar=VV) + "\n## Hoje\n" + emb("Diário", "Hoje")
    + "\n\n## Esta semana\n" + emb("Diário", "Esta semana") + "\n\n## Histórico\n" + emb("Diário", "Histórico") + "\n")
add(f"{V}/Rotina/😊 Humor e Gratidão.md", tela() + topo("😊 Humor e Gratidão", voltar=VV) + "\n## Hoje\n" + emb("Diário", "Hoje")
    + "\n\n## Histórico\n" + emb("Diário", "Histórico") + "\n")
add(f"{V}/Rotina/🏋️ Treinos.md", tela() + topo("🏋️ Treinos", voltar=VV) + "\n## Esta semana\n" + emb("Rotina", "Treinos da semana")
    + "\n\n## Histórico\n" + emb("Rotina", "Treinos") + "\n")
LISTAS = [("rosa", "🛒", "Supermercado"), ("menta", "💊", "Farmácia"), ("salvia", "🐾", "Pets"),
          ("pessego", "🏠", "Casa"), ("lilas", "🛍️", "Pessoal"), ("amarelo", "📦", "Outros")]
add(f"{V}/Casa/🛒 Casa e Compras.md", tela() + topo("🛒 Casa e Compras", voltar=VV) + "\n## 🛒 Listas de compras\n"
    + cartoes([(c, i, f"{COMPRAS}/{n}", n) for c, i, n in LISTAS], "sc-grade-p")
    + f"\n## 🏠 Casa\n" + cartoes([("ceu", "🏠", f"{V}/Casa/Casa", "Minha casa")], "sc-grade-p")
    + "\n## 🔧 Equipamentos e manutenções\n" + emb("Rotina", "Equipamentos") + "\n")
for _, icone, nome in LISTAS:
    add(f"{COMPRAS}/{nome}.md", f"---\ntipo: lista_compras\nlista: {nome.lower()}\n---\n# {icone} {nome}\n\n")
add(f"{V}/📁 Documentos.md", tela() + topo("📁 Documentos", voltar=VV) + "\n" + emb("Rotina", "Documentos") + "\n")

# =============================================================== modelos
add(f"{M}/Modelo - Dia.md", """---
tipo: dia
humor:
energia:
sono:
---
## 😊 Como estou
- Emoção predominante:
- Observações:

## 🙏 Gratidão

## ✨ Algo bom que aconteceu

## 💭 Reflexão

## 🎯 Intenção para amanhã
""")
CAPT = {
    "Tarefa": """---
tipo: tarefa
feita: false
data: {{VDATE:Quando? ex. hoje ou amanhã,YYYY-MM-DD}}
prazo:
area: {{VALUE:vida,trabalho,projetos,casa,financeiro,família,estudos}}
prioridade: {{VALUE:normal,alta,baixa}}
projeto:
pessoa:
---
""",
    "Compromisso": """---
tipo: compromisso
data: {{VDATE:Que dia? ex. sexta,YYYY-MM-DD}}
hora: "{{VALUE:Hora ex. 14h30}}"
local:
pessoa:
---
""",
    "Despesa": """---
tipo: lancamento
natureza: despesa
valor: {{VALUE:Valor ex. 45.90}}
data: {{DATE:YYYY-MM-DD}}
vencimento:
categoria: {{VALUE:mercado,casa,moradia,saúde,educação,transporte,lazer,assinatura,pets,outros}}
status: {{VALUE:pago,pendente}}
forma_pagamento:
---
""",
    "Ideia": "---\ntipo: ideia\narea:\n---\n{{VALUE:Ideia}}\n",
    "Informação": "---\ntipo: informacao\narea:\n---\n{{VALUE:Informação}}\n",
    "Link": "---\ntipo: referencia\nurl: {{VALUE:Cole o link}}\ncategoria:\n---\n",
    "Receita": "---\ntipo: receita\ncategoria:\norigem:\ntempo_preparo:\n---\n## Ingredientes\n- \n\n## Modo de preparo\n1. \n",
    "Treino": """---
tipo: treino
data: {{DATE:YYYY-MM-DD}}
tipo_treino: {{VALUE:musculação,cardio,funcional,yoga,outro}}
realizado: true
duracao_min:
cardio_min:
---
| Exercício | Séries | Repetições | Carga (kg) |
|---|---|---|---|
|  |  |  |  |

## Observações
""",
}
for nome, conteudo in CAPT.items():
    add(f"{CAP}/{nome}.md", conteudo)

# =============================================================== configuração (aplicada pelo plugin Ponte)
ABRIR = {"location": "tab", "direction": "vertical", "mode": "default", "focus": True}


def escolha_modelo(nome, modelo, pasta, nome_arquivo):
    return {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "sc/" + nome)), "name": nome, "type": "Template", "command": True,
            "templatePath": f"{CAP}/{modelo}.md",
            "folder": {"enabled": True, "folders": [pasta], "chooseWhenCreatingNote": False,
                       "createInSameFolderAsActiveFile": False, "chooseFromSubfolders": False},
            "fileNameFormat": {"enabled": True, "format": nome_arquivo},
            "appendLink": False, "copyLinkToClipboard": False, "openFile": True, "fileOpening": ABRIR,
            "fileExistsBehavior": {"kind": "prompt"}}


def escolha_captura(nome, destino, formato, depois=None, modelo=None, abrir=False, propriedade=None):
    c = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "sc/" + nome)), "name": nome, "type": "Capture", "command": True,
         "captureTo": destino, "captureToActiveFile": False, "captureToCanvasNodeId": "", "activeFileWritePosition": "cursor",
         "createFileIfItDoesntExist": {"enabled": True, "createWithTemplate": bool(modelo), "template": modelo or ""},
         "format": {"enabled": True, "format": formato}, "prepend": False, "appendLink": False, "copyLinkToClipboard": False,
         "task": False,
         "insertAfter": {"enabled": bool(depois), "after": depois or "", "insertAtEnd": True, "considerSubsections": False,
                         "createIfNotFound": True, "createIfNotFoundLocation": "bottom", "inline": False,
                         "replaceExisting": False, "blankLineAfterMatchMode": "auto", "promptHeading": False},
         "insertBefore": {"enabled": False, "before": "", "createIfNotFound": False, "createIfNotFoundLocation": "top"},
         "newLineCapture": {"enabled": False, "direction": "below"},
         "openFile": abrir, "fileOpening": ABRIR, "templater": {"afterCapture": "none"}}
    if propriedade:
        c["propertyCapture"] = {"property": {"kind": "named", "format": propriedade}, "action": "set",
                                "createIfMissing": True, "sort": "none"}
    return c


HOJE = DIA + "/{{DATE:YYYY-MM-DD}}.md"
compras = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "sc/compras")), "name": "🛒 Compra", "type": "Multi",
           "command": True, "collapsed": False,
           "choices": [escolha_captura(f"🛒 {n}", f"{COMPRAS}/{n}.md", "- [ ] {{VALUE:O que comprar?}}\n") for _, _, n in LISTAS]}
ESCOLHAS = [
    escolha_modelo("✅ Tarefa", "Tarefa", AG, "{{VALUE:Qual é a tarefa?}}"),
    escolha_modelo("🗓️ Compromisso", "Compromisso", AG, "{{VALUE:Qual é o compromisso?}}"),
    escolha_modelo("💸 Despesa", "Despesa", "06 - Financeiro", "{{VALUE:Com o que gastei?}}"),
    compras,
    escolha_modelo("💡 Ideia", "Ideia", "00 - Entrada", "Ideia {{DATE:YYYY-MM-DD HHmm}}"),
    escolha_modelo("🍲 Receita", "Receita", "03 - Conhecimento", "{{VALUE:Nome da receita}}"),
    escolha_captura("😊 Humor", HOJE, "{{VALUE:😄 Muito bem,🙂 Bem,😐 Normal,😔 Para baixo,😣 Difícil}}",
                    modelo=f"{M}/Modelo - Dia.md", abrir=True, propriedade="humor"),
    escolha_captura("🙏 Gratidão", HOJE, "- {{VALUE:Sou grata por}}\n", depois="## 🙏 Gratidão", modelo=f"{M}/Modelo - Dia.md"),
    escolha_modelo("🏋️ Treino", "Treino", TREINOS, "Treino {{DATE:YYYY-MM-DD}}"),
    escolha_modelo("ℹ️ Informação", "Informação", "00 - Entrada", "{{VALUE:Sobre o quê?}}"),
    escolha_modelo("🔗 Link", "Link", "00 - Entrada", "{{VALUE:Título do link}}"),
]
FAVORITOS = [
    ("🏠 Início", "🏠 Minha Central.md", None), ("📅 Agenda", "07 - Agenda/📅 Planejamento.md", None),
    ("✅ Tarefas", "07 - Agenda/📅 Planejamento.md", "#✅ Tarefas"), ("🔁 Hábitos", f"{V}/Rotina/🔁 Hábitos.md", None),
    ("😊 Humor e Gratidão", f"{V}/Rotina/😊 Humor e Gratidão.md", None), ("🏋️ Treinos", f"{V}/Rotina/🏋️ Treinos.md", None),
    ("📚 Estudos", "03 - Conhecimento/📚 Conhecimento.md", "#🎓 Estudos"),
    ("🏡 Minha Vida", f"{V}/🏡 Minha Vida.md", None), ("🛒 Casa e Compras", f"{V}/Casa/🛒 Casa e Compras.md", None),
    ("💰 Financeiro", "06 - Financeiro/💰 Meu Financeiro.md", None), ("⚖️ Trabalho", "02 - Trabalho/⚖️ Trabalho.md", None),
    ("🚀 Projetos", "04 - Projetos/🚀 Projetos.md", None), ("📁 Documentos", f"{V}/📁 Documentos.md", None),
    ("📥 Entrada", "00 - Entrada/Caixa de Entrada.md", None),
]
CONFIG = {
    "versao": 2,
    "organizar": {
        "mover": [
            {"de": "📅 Planejamento.md", "para": "07 - Agenda/📅 Planejamento.md"},
            {"de": "📁 Documentos.md", "para": "01 - Vida/📁 Documentos.md"},
            {"de": "01 - Vida/Família.md", "para": "01 - Vida/Família/Família.md"},
            {"de": "01 - Vida/Nicolas.md", "para": "01 - Vida/Família/Nicolas.md"},
            {"de": "01 - Vida/🛒 Casa e Compras.md", "para": "01 - Vida/Casa/🛒 Casa e Compras.md"},
            {"de": "01 - Vida/Casa.md", "para": "01 - Vida/Casa/Casa.md"},
            {"de": "01 - Vida/Máquina de Lavar.md", "para": "01 - Vida/Casa/Máquina de Lavar.md"},
            {"de": "01 - Vida/Compras", "para": "01 - Vida/Casa/Compras"},
            {"de": "01 - Vida/Saúde.md", "para": "01 - Vida/Saúde/Saúde.md"},
            {"de": "01 - Vida/Pets.md", "para": "01 - Vida/Pets/Pets.md"},
            {"de": "01 - Vida/Viagens.md", "para": "01 - Vida/Viagens/Viagens.md"},
            {"de": "01 - Vida/🔁 Hábitos.md", "para": "01 - Vida/Rotina/🔁 Hábitos.md"},
            {"de": "01 - Vida/😊 Humor e Gratidão.md", "para": "01 - Vida/Rotina/😊 Humor e Gratidão.md"},
            {"de": "01 - Vida/🏋️ Treinos.md", "para": "01 - Vida/Rotina/🏋️ Treinos.md"},
            {"de": "01 - Vida/Diário", "para": "01 - Vida/Rotina/Diário"},
            {"de": "01 - Vida/Treinos", "para": "01 - Vida/Rotina/Treinos"},
        ],
        "lixeira": [
            {"caminho": "Sem título.canvas", "condicao": "canvas_vazio"},
            {"caminho": "Sem título 1.canvas", "condicao": "canvas_vazio"},
            {"caminho": "05 - Sistema/Painéis/Planejamento.base", "condicao": "sem_uso"},
            {"caminho": "05 - Sistema/Painéis/Entrada.base", "condicao": "sem_uso"},
            {"caminho": "05 - Sistema/Painéis/Vida.base", "condicao": "sem_uso"},
        ],
    },
    "pastas": [AG, DIA, TREINOS, COMPRAS],
    "favoritos": {"grupo": "🧠 Segundo Cérebro", "itens": [{"titulo": t, "caminho": c, **({"subpath": s} if s else {})} for t, c, s in FAVORITOS]},
    "inicio": {"nota": "🏠 Minha Central", "modo": "Reading view"},
    "diario": {"pasta": DIA, "modelo": f"{M}/Modelo - Dia", "formato": "YYYY-MM-DD"},
    "captura": {"escolhas": ESCOLHAS, "iconeNaBarra": True},
}
add("05 - Sistema/⚙️ Configuração do Segundo Cérebro.md",
    "---\ncssclasses:\n  - sc-app\ntipo: configuracao\n---\n"
    "# ⚙️ Configuração do Segundo Cérebro\n\n"
    "Aplicada pelo plugin **Ponte** no computador principal (com backup em `05 - Sistema/Backups`). "
    "Não é preciso editar esta nota.\n\n```json\n" + json.dumps(CONFIG, ensure_ascii=False, indent=1) + "\n```\n",
    "substituir")

# =============================================================== CSS
css = (AQUI / "app.css").read_text() + "\n\n/* ===== v1 (áreas ainda não refeitas) ===== */\n" + (AQUI.parent / "segundo-cerebro-dashboard.css").read_text()
add(".obsidian/snippets/segundo-cerebro-dashboard.css", css, "substituir")

if __name__ == "__main__":
    (AQUI / "pedidos.json").write_text(json.dumps(PEDIDOS, ensure_ascii=False, indent=1))
    for p in PEDIDOS:
        print(f"{p['acao']:10} {p['caminho']}")
    print(len(PEDIDOS), "pedidos")
