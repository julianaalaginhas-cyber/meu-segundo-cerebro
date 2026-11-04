"""Visual v2 — gera as telas aprovadas por etapas (agora: Central e Minha Vida).

Saída: interface/v2/saida/<caminho>  +  interface/v2/pedidos.json (caminho, acao, conteudo)
"""
import json
import shutil
from pathlib import Path

AQUI = Path(__file__).parent
SAIDA = AQUI / "saida"
P = "05 - Sistema/Painéis"
PEDIDOS = []  # (caminho, acao, conteudo)

AVISO = ("> [!sc-aviso-css] ⚠️ O visual está desligado\n"
         "> Configurações → Aparência → Trechos CSS → ative **segundo-cerebro-dashboard**.\n")


def tela(props: str = "") -> str:
    return f"---\ncssclasses:\n  - sc-app\n{props}---\n{AVISO}\n"


def topo(titulo: str, voltar: str | None = None, sub: str | None = None) -> str:
    linhas = [f"> [!sc-topo] {titulo}"]
    partes = []
    if voltar:
        partes.append(voltar)
    if sub:
        partes.append(sub)
    if partes:
        linhas.append("> " + " · ".join(partes))
    return "\n".join(linhas) + "\n"


def grade(cartoes, pequena=False) -> str:
    tipo = "sc-grade-p" if pequena else "sc-grade"
    linhas = [f"> [!{tipo}]"]
    for i, (cor, icone, alvo, rotulo) in enumerate(cartoes):
        if i:
            linhas.append(">")
        linhas.append(f"> > [!sc-c-{cor}] {icone}")
        linhas.append(f"> > [[{alvo}|{rotulo}]]")
    return "\n".join(linhas) + "\n"


def painel(titulo: str, vista: str) -> str:
    return f"## {titulo}\n![[{P}/Telas.base#{vista}]]\n"


def add(caminho, conteudo, acao="criar"):
    PEDIDOS.append((caminho, acao, conteudo))


VOLTA_CENTRAL = "[[🏠 Minha Central|‹ Central]]"
VOLTA_VIDA = "[[01 - Vida/🏡 Minha Vida|‹ Minha Vida]]"

# ------------------------------------------------------------------ 🏠 Minha Central
add("🏠 Minha Central.md", tela() + topo("🧠 Meu Segundo Cérebro", sub="Minha vida, minhas ideias e meus projetos.") + "\n" + grade([
    ("rosa", "🏡", "01 - Vida/🏡 Minha Vida", "Minha Vida"),
    ("lilas", "⚖️", "02 - Trabalho/⚖️ Trabalho", "Trabalho"),
    ("pessego", "🚀", "04 - Projetos/🚀 Projetos", "Projetos"),
    ("salvia", "📚", "03 - Conhecimento/📚 Conhecimento", "Conhecimento"),
    ("menta", "💰", "06 - Financeiro/💰 Meu Financeiro", "Financeiro"),
    ("roxo", "📅", "📅 Planejamento", "Planejamento"),
    ("coral", "📥", "00 - Entrada/Caixa de Entrada", "Entrada"),
]) + "\n" + painel("✅ Tarefas para hoje e atrasadas", "Tarefas")
    + "\n" + painel("⏳ Vencimentos nos próximos 30 dias", "Vencimentos")
    + "\n" + painel("🚀 Projetos ativos", "Projetos ativos"), acao="substituir")

# ------------------------------------------------------------------ 🏡 Minha Vida
V = "01 - Vida"
add(f"{V}/🏡 Minha Vida.md", tela() + topo("🏡 Minha Vida", voltar=VOLTA_CENTRAL) + "\n" + grade([
    ("rosa", "👪", f"{V}/Família", "Família"),
    ("ceu", "👦", f"{V}/Nicolas", "Nicolas"),
    ("pessego", "🏠", f"{V}/Casa", "Casa"),
    ("salvia", "🐾", f"{V}/Pets", "Pets"),
    ("menta", "🩺", f"{V}/Saúde", "Saúde"),
    ("lilas", "✈️", f"{V}/Viagens", "Viagens"),
], pequena=True) + "\n" + painel("⏳ Próximas datas", "Vida - próximas datas"), acao="substituir")

# Notas que os cartões abrem (novas; nada existente é alterado). "Casa" já existe.
add(f"{V}/Família.md", tela() + topo("👪 Família", voltar=VOLTA_VIDA) + "\n" + painel("Pessoas", "Família"))
add(f"{V}/Nicolas.md", tela("tipo: pessoa\nrelacao: filho\n") + topo("👦 Nicolas", voltar=VOLTA_VIDA) + "\n"
    + painel("Saúde, vacinas e consultas", "Nicolas") + "\n" + painel("Próximas datas", "Nicolas - próximas datas"))
add(f"{V}/Pets.md", tela() + topo("🐾 Pets", voltar=VOLTA_VIDA) + "\n" + painel("Registros", "Pets"))
add(f"{V}/Saúde.md", tela() + topo("🩺 Saúde", voltar=VOLTA_VIDA) + "\n" + painel("Consultas e exames", "Saúde"))
add(f"{V}/Viagens.md", tela() + topo("✈️ Viagens", voltar=VOLTA_VIDA) + "\n" + painel("Viagens", "Viagens"))

# ------------------------------------------------------------------ painéis (Bases)
PROX = ('if(proxima_manutencao, date(proxima_manutencao), if(vencimento, date(vencimento), '
        'if(proxima_dose, date(proxima_dose), if(validade, date(validade), if(proxima_cobranca, date(proxima_cobranca), '
        'if(garantia_ate, date(garantia_ate), if(tipo == "processo" && prazo, date(prazo))))))))')
OQUE = ('if(proxima_manutencao, "🔧 Manutenção", if(vencimento, "💳 Vencimento", if(proxima_dose, "💉 Dose", '
        'if(validade, "🪪 Validade", if(proxima_cobranca, "🔁 Cobrança", if(garantia_ate, "🛡️ Garantia", '
        'if(tipo == "processo", "⚖️ Prazo")))))))')


def vista(nome, filtros, colunas, extra=""):
    f = "".join(f"        - '{x}'\n" for x in filtros)
    c = "".join(f"      - {x}\n" for x in colunas)
    return f"  - type: table\n    name: \"{nome}\"\n    filters:\n      and:\n{f}    order:\n{c}{extra}"


ATIVO = ['status != "pago"', 'status != "cancelada"', 'status != "feita"']
add(f"{P}/Telas.base", f"""filters:
  and:
    - '!file.inFolder("05 - Sistema")'
formulas:
  data_chave: '{PROX}'
  o_que: '{OQUE}'
properties:
  file.name:
    displayName: Nota
  formula.data_chave:
    displayName: Data
  formula.o_que:
    displayName: O quê
views:
{vista("Tarefas", ['tipo == "tarefa"', 'status != "feita"', 'date(prazo) <= today()'], ["file.name", "prazo", "area"])}
{vista("Vencimentos", ATIVO + ['formula.data_chave <= today() + "30d"'], ["file.name", "formula.o_que", "formula.data_chave"])}
{vista("Projetos ativos", ['tipo == "projeto"', 'status == "ativo" || status == "planejamento" || status == "em andamento"'], ["file.name", "status", "prazo"])}
{vista("Vida - próximas datas", ['file.inFolder("01 - Vida")'] + ATIVO + ['formula.data_chave <= today() + "90d"'], ["file.name", "formula.o_que", "formula.data_chave"])}
{vista("Família", ['tipo == "pessoa"'], ["file.name", "relacao", "aniversario"])}
{vista("Nicolas", ['pessoa == "Nicolas"'], ["file.name", "evento", "data", "proxima_dose"])}
{vista("Nicolas - próximas datas", ['pessoa == "Nicolas"'] + ATIVO + ['formula.data_chave >= today()'], ["file.name", "formula.o_que", "formula.data_chave"])}
{vista("Pets", ['tipo == "pet" || area == "pets"'], ["file.name", "evento", "data", "proxima_dose"])}
{vista("Saúde", ['tipo == "saude"'], ["file.name", "pessoa", "evento", "data"])}
{vista("Viagens", ['tipo == "viagem"'], ["file.name", "destino", "data_ida", "status"])}
""")

# ------------------------------------------------------------------ documentação (o texto que saiu das telas)
add("05 - Sistema/📘 Como usar o Segundo Cérebro.md", """# 📘 Como usar o Segundo Cérebro

## Telas
- Abra **🏠 Minha Central** (deixe nos Favoritos). Cada cartão abre uma área.
- As telas ficam melhores no **modo de leitura** (ícone de livro 📖 no topo da nota, ou `Ctrl+E` no Windows).
- Se aparecer "⚠️ O visual está desligado": Configurações → Aparência → Trechos CSS → ative **segundo-cerebro-dashboard**.

## Registrar algo rápido
- Crie uma nota nova (botão ✏️ / `Ctrl+N`). Com "Local padrão para novas notas" = `00 - Entrada`, tudo cai na Entrada.
- Para já sair organizado, use um modelo (Inserir modelo): Tarefa, Receita, Lançamento financeiro, Conta fixa ou assinatura, Equipamento ou manutenção.

## Propriedades que alimentam os painéis
- Datas sempre no formato `AAAA-MM-DD` (ex.: 2026-11-30).
- **Tarefa:** `tipo: tarefa`, `status: pendente` ou `feita`, `prazo`.
- **Vencimentos:** `proxima_manutencao`, `vencimento`, `proxima_dose`, `validade`, `proxima_cobranca`, `garantia_ate`.
- **Pessoa:** `tipo: pessoa`, `relacao`, `aniversario`.
- **Nicolas:** registros de saúde com `tipo: saude` e `pessoa: Nicolas` (evento: vacina, consulta ou exame).
- **Projeto:** `tipo: projeto`, `status`: ideia, planejamento, ativo, pausado ou concluído.
- **Privado:** `privado: true` impede a nota de ir para a nuvem e para as IAs.

## O que o Obsidian não faz sozinho
- Não envia notificações para o iPhone (os painéis só mostram as datas).
- Caixinhas `- [ ]` soltas em notas não aparecem nos painéis (use notas de tarefa).
""")

# ------------------------------------------------------------------ CSS: v2 + regras antigas (para as áreas ainda não refeitas)
css_v1 = (AQUI.parent / "segundo-cerebro-dashboard.css").read_text()
css = (AQUI / "app.css").read_text() + "\n\n/* ===== v1 (áreas ainda não refeitas) ===== */\n" + css_v1
add(".obsidian/snippets/segundo-cerebro-dashboard.css", css, acao="substituir")

if __name__ == "__main__":
    if SAIDA.exists():
        shutil.rmtree(SAIDA)
    for caminho, acao, conteudo in PEDIDOS:
        alvo = SAIDA / caminho
        alvo.parent.mkdir(parents=True, exist_ok=True)
        alvo.write_text(conteudo, encoding="utf-8")
    (AQUI / "pedidos.json").write_text(json.dumps([{"caminho": c, "acao": a, "conteudo": t} for c, a, t in PEDIDOS], ensure_ascii=False, indent=1))
    for c, a, _ in PEDIDOS:
        print(f"{a:10} {c}")
