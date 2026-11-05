"""Etapa de arrumação: refaz Trabalho, Projetos, Conhecimento e Financeiro no visual v3.

Gera interface/v3/pedidos-areas.json. As páginas e os painéis (.base) das 4 áreas são
SUBSTITUÍDOS (o plugin faz backup antes).
"""
import json
from pathlib import Path

import etapa1 as e  # reaproveita tela(), topo(), vista(), larguras()...

AQUI = Path(__file__).parent
P = e.P
PED = []
DRIVE = "https://drive.google.com/drive/folders/"
PASTA = {  # só pastas de área (sem nomes de clientes)
    "trabalho": "18LO-K5HpyDHTlr76GiiDTR3ZXpkqNKgj",
    "projetos": "1AZO2UQ3t2O8bYrzubUceemPSe3gXv82i",
    "conhecimento": "1NS2QemUKbGthIqHRRVaKYlSP1wv07MUg",
    "financeiro": "1VKYh7CzJNGT6bb4zD1IFdRUd0xxUDfH5",
}
SEM_SISTEMA = "    - '!file.inFolder(\"05 - Sistema\")'\n"


def add(caminho, conteudo):
    PED.append({"caminho": caminho, "acao": "substituir", "conteudo": conteudo})


def pagina(titulo, area, paineis):
    drive = f"[📂 Arquivos no Drive]({DRIVE}{PASTA[area]})"
    corpo = e.tela() + e.topo(titulo, voltar=e.VC, sub=drive) + "\n"
    corpo += "\n".join(e.painel(t, b, v) for t, b, v in paineis)
    return corpo


def base(formulas, propriedades, vistas):
    f = "".join(f"  {k}: '{v}'\n" for k, v in formulas.items())
    p = "".join(f"  {k}:\n    displayName: \"{v}\"\n" for k, v in propriedades.items())
    return ("filters:\n  and:\n" + SEM_SISTEMA + (f"formulas:\n{f}" if f else "")
            + f"properties:\n{p}views:\n" + "\n".join(vistas) + "\n")


def ordem(prop, direcao="ASC"):
    return f"    sort:\n      - property: {prop}\n        direction: {direcao}\n"


def soma(*props):
    return "    summaries:\n" + "".join(f"      {x}: Sum\n" for x in props)


PENDENTE_T = ['tipo == "tarefa"', 'feita != true', 'status != "feita"']

# ------------------------------------------------------------------ ⚖️ Trabalho
add(f"{P}/Trabalho.base", base({}, {"file.name": "Nota"}, [
    e.vista("Prazos e pendências", PENDENTE_T + ['area == "trabalho"'], ["feita", "file.name", "prazo", "data", "cliente"], ordem("prazo")),
    e.vista("Prazos de processos", ['tipo == "processo"', 'prazo', 'status != "encerrado"'], ["file.name", "prazo", "cliente", "status"], ordem("prazo")),
    e.vista("Reuniões", ['tipo == "reuniao"'], ["file.name", "data", "cliente"], ordem("data", "DESC")),
    e.vista("Clientes", ['tipo == "cliente"'], ["file.name", "status", "contato"]),
    e.vista("Processos", ['tipo == "processo"'], ["file.name", "cliente", "numero", "status", "prazo"]),
    e.vista("Contratos", ['tipo == "contrato"'], ["file.name", "cliente", "status", "vigencia_ate"]),
    e.vista("Modelos jurídicos", ['tipo == "modelo_juridico"'], ["file.name", "file.mtime"]),
]))
add("02 - Trabalho/⚖️ Trabalho.md", pagina("⚖️ Trabalho", "trabalho", [
    ("⏳ Prazos e pendências", "Trabalho", "Prazos e pendências"),
    ("👤 Clientes, processos e contratos", "Trabalho", "Clientes"),
]))

# ------------------------------------------------------------------ 🚀 Projetos
ATIVO = 'status == "ativo" || status == "planejamento" || status == "em andamento"'
add(f"{P}/Projetos.base", base({}, {"file.name": "Projeto"}, [
    e.vista("Em andamento", ['tipo == "projeto"', ATIVO], ["file.name", "status", "prioridade", "area", "prazo"], ordem("prazo")),
    e.vista("Pausados", ['tipo == "projeto"', 'status == "pausado"'], ["file.name", "prioridade", "area", "prazo"]),
    e.vista("Concluídos", ['tipo == "projeto"', 'status == "concluído" || status == "concluido"'], ["file.name", "area", "prazo"]),
    e.vista("Ideias", ['tipo == "projeto" && status == "ideia" || tipo == "ideia"'], ["file.name", "area", "file.ctime"]),
    e.vista("Próximas ações", PENDENTE_T + ['projeto'], ["feita", "file.name", "projeto", "data", "prioridade"],
            "    groupBy:\n      property: projeto\n      direction: ASC\n" + ordem("data")),
]))
add("04 - Projetos/🚀 Projetos.md", pagina("🚀 Projetos", "projetos", [
    ("🟢 Projetos", "Projetos", "Em andamento"),
    ("➡️ Próximas ações", "Projetos", "Próximas ações"),
]))

# ------------------------------------------------------------------ 📚 Conhecimento
add(f"{P}/Conhecimento.base", base({}, {"file.name": "Nota"}, [
    e.vista("Livros", ['tipo == "livro"'], ["file.name", "autor", "status", "nota"], "    groupBy:\n      property: status\n      direction: ASC\n"),
    e.vista("Estudos e cursos", ['tipo == "estudo" || tipo == "curso"'], ["file.name", "tema", "status", "proxima_revisao"]),
    e.vista("Referências", ['tipo == "referencia"'], ["file.name", "categoria", "url"], ordem("file.ctime", "DESC")),
    e.vista("Ideias", ['tipo == "ideia"'], ["file.name", "area", "file.ctime"], ordem("file.ctime", "DESC")),
    e.vista("Receitas", ['tipo == "receita"'], ["file.name", "categoria", "tempo_preparo", "origem"], "    groupBy:\n      property: categoria\n      direction: ASC\n"),
]))
add("03 - Conhecimento/📚 Conhecimento.md", pagina("📚 Conhecimento", "conhecimento", [
    ("📖 Biblioteca", "Conhecimento", "Livros"),
    ("🍲 Receitas", "Conhecimento", "Receitas"),
]))

# ------------------------------------------------------------------ 💰 Financeiro
MES = 'date(data).year == today().year && date(data).month == today().month'
add(f"{P}/Financeiro.base", base({
    "saldo": 'if(natureza == "despesa", 0 - valor, valor)',
    "progresso": 'if(valor_meta, ((valor_acumulado / valor_meta) * 100).round() + "%")',
    "falta": 'if(valor_meta, valor_meta - valor_acumulado)',
}, {"file.name": "Descrição", "formula.saldo": "Saldo", "formula.progresso": "Progresso", "formula.falta": "Falta"}, [
    e.vista("Resumo do mês", ['tipo == "lancamento"', MES], ["file.name", "natureza", "categoria", "valor", "formula.saldo", "data", "status"],
            "    groupBy:\n      property: natureza\n      direction: ASC\n" + soma("valor", "formula.saldo")),
    e.vista("Gastos por categoria", ['tipo == "lancamento"', 'natureza == "despesa"', MES], ["file.name", "valor", "data"],
            "    groupBy:\n      property: categoria\n      direction: ASC\n" + soma("valor")),
    e.vista("Orçamento", ['tipo == "orcamento"'], ["file.name", "categoria", "valor_previsto", "mes"], soma("valor_previsto")),
    e.vista("Contas a pagar", ['tipo == "lancamento"', 'natureza == "despesa"', 'status == "pendente"'], ["file.name", "valor", "vencimento", "categoria"], ordem("vencimento") + soma("valor")),
    e.vista("Contas a receber", ['tipo == "lancamento"', 'natureza == "receita"', 'status != "recebido"'], ["file.name", "origem", "valor", "data"], ordem("data") + soma("valor")),
    e.vista("Contas fixas", ['tipo == "recorrente"', 'categoria != "assinatura"', 'status != "cancelada"'], ["file.name", "categoria", "valor", "periodicidade", "proxima_cobranca"], soma("valor")),
    e.vista("Assinaturas", ['tipo == "recorrente"', 'categoria == "assinatura"'], ["file.name", "valor", "moeda", "periodicidade", "proxima_cobranca", "status"], soma("valor")),
    e.vista("Metas", ['tipo == "meta_financeira"'], ["file.name", "valor_meta", "valor_acumulado", "formula.progresso", "formula.falta", "prazo"]),
    e.vista("Patrimônio", ['tipo == "patrimonio"'], ["file.name", "categoria", "valor_estimado", "instituicao"], soma("valor_estimado")),
]))
add("06 - Financeiro/💰 Meu Financeiro.md", pagina("💰 Financeiro", "financeiro", [
    ("📆 Este mês", "Financeiro", "Resumo do mês"),
    ("💳 Contas e assinaturas", "Financeiro", "Contas a pagar"),
    ("🎯 Metas e patrimônio", "Financeiro", "Metas"),
]))

if __name__ == "__main__":
    (AQUI / "pedidos-areas.json").write_text(json.dumps(PED, ensure_ascii=False, indent=1))
    for p in PED:
        print(p["acao"], p["caminho"])
