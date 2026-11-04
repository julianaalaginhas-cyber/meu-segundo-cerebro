"""Gera os arquivos da interface do Segundo Cérebro (notas de painel, Bases e modelos).

Saída: interface/vault/<caminho no Vault>. Nada aqui contém dados pessoais.
Uso: python3 interface/gerar.py
"""
from pathlib import Path
from urllib.parse import quote
import shutil

VAULT = "Meu Segundo Cérebro"
RAIZ = Path(__file__).parent / "vault"
P = "05 - Sistema/Painéis"          # onde ficam os arquivos .base

ARQ = {}  # caminho -> conteúdo


def novo(arquivo: str, conteudo: str) -> str:
    """Link obsidian:// que cria uma nota nova já com as propriedades preenchidas."""
    return ("obsidian://new?vault=" + quote(VAULT, safe="") + "&file=" + quote(arquivo, safe="")
            + "&content=" + quote(conteudo, safe=""))


def botao(rotulo: str, arquivo: str, conteudo: str) -> str:
    return f"[{rotulo}]({novo(arquivo, conteudo)})"


def fm(**props) -> str:
    linhas = ["---"]
    for k, v in props.items():
        linhas.append(f"{k}: {'' if v is None else v}".rstrip())
    linhas.append("---")
    return "\n".join(linhas) + "\n"


def painel(area: str) -> str:
    return f"---\ncssclasses:\n  - sc-painel\n  - sc-{area}\n---\n"


def base(nome: str, vista: str) -> str:
    return f"![[{P}/{nome}.base#{vista}]]"


# ---------------------------------------------------------------- modelos de captura
T = {
    "ideia": fm(tipo="ideia", area=None) + "\n💡 Escreva a ideia aqui.\n",
    "tarefa": fm(tipo="tarefa", status="pendente", prazo=None, area=None) + "\n✅ O que precisa ser feito?\n\n> Preencha **prazo** no formato AAAA-MM-DD (ex.: 2026-11-30). Quando terminar, mude **status** para `feita`.\n",
    "lembrete": fm(tipo="lembrete", data=None, hora=None) + "\n⏰ Do que preciso lembrar?\n\n> Preencha **data** no formato AAAA-MM-DD.\n",
    "link": fm(tipo="referencia", url=None, categoria=None) + "\n🔗 Cole o link em **url** e anote por que salvou.\n",
    "receita": fm(tipo="receita", categoria=None, origem=None, tempo_preparo=None) + "\n## Ingredientes\n- \n\n## Modo de preparo\n1. \n",
    "info": fm(tipo="informacao", area=None) + "\nℹ️ Escreva a informação aqui.\n",
    "anotacao": fm(tipo="anotacao") + "\n📝 \n",
    "pessoa": fm(tipo="pessoa", relacao=None, aniversario=None, telefone=None) + "\n## Informações importantes\n\n## Datas\n",
    "documento": fm(tipo="documento", pessoa=None, documento=None, numero=None, emissao=None, validade=None) + "\n> Arraste o arquivo (PDF ou foto) para esta nota. Datas no formato AAAA-MM-DD.\n",
    "equipamento": fm(tipo="equipamento", area="casa", status="ativo", ultima_manutencao=None, frequencia_meses=None, proxima_manutencao=None, garantia_ate=None) + "\n## Histórico de manutenção\n- \n\n## Documentos relacionados\n- Manual: \n- Nota fiscal: \n",
    "saude_nicolas": fm(tipo="saude", pessoa="Nicolas", evento=None, data=None, proxima_dose=None, profissional=None) + "\n> **evento**: vacina, consulta ou exame. Copie os dados da carteirinha ou do laudo.\n",
    "saude": fm(tipo="saude", pessoa=None, evento=None, data=None, profissional=None) + "\n## Anotações\n",
    "pet": fm(tipo="pet", area="pets", evento=None, data=None, proxima_dose=None) + "\n## Anotações\n",
    "viagem": fm(tipo="viagem", destino=None, data_ida=None, data_volta=None, status="planejando") + "\n## Reservas\n\n## Roteiro\n\n## Checklist\n- [ ] Documentos\n",
    "cliente": fm(tipo="cliente", status="ativo", contato=None) + "\n## Processos e contratos\n\n## Histórico de negociações\n",
    "processo": fm(tipo="processo", cliente=None, numero=None, status="em andamento", prazo=None) + "\n## Documentos\n\n## Andamentos\n\n## Decisões\n",
    "contrato": fm(tipo="contrato", cliente=None, status="em negociação", vigencia_ate=None) + "\n## Cláusulas importantes\n\n## Versões\n\n## Histórico de negociação\n",
    "reuniao": fm(tipo="reuniao", cliente=None, data=None) + "\n## Pauta\n\n## Decisões\n\n## Próximos passos\n",
    "prazo_trab": fm(tipo="tarefa", status="pendente", prazo=None, area="trabalho", cliente=None) + "\n⚖️ Descreva o prazo ou a pendência.\n",
    "projeto": fm(tipo="projeto", status="planejamento", area=None, prioridade=None, data_inicio=None, prazo=None) + "\n## Objetivo\n\n## Próximas ações\n- [ ] \n\n## Decisões tomadas\n\n## Documentos e referências\n",
    "livro": fm(tipo="livro", autor=None, status="quero ler", nota=None) + "\n## Resumo\n\n## Aprendizados\n",
    "estudo": fm(tipo="estudo", tema=None, status="em andamento", origem=None) + "\n## Anotações\n",
    "despesa": fm(tipo="lancamento", natureza="despesa", valor=None, data=None, vencimento=None, categoria=None, status="pendente", forma_pagamento=None, recorrencia="não") + "\n> **valor** só com números e ponto (ex.: 120.50). Datas AAAA-MM-DD. Quando pagar, mude **status** para `pago`.\n",
    "receita_fin": fm(tipo="lancamento", natureza="receita", valor=None, data=None, origem=None, categoria=None, status="a receber", data_recebida=None) + "\n> Quando receber, mude **status** para `recebido` e preencha **data_recebida**.\n",
    "recorrente": fm(tipo="recorrente", categoria=None, valor=None, moeda="BRL", periodicidade="mensal", proxima_cobranca=None, status="ativa", forma_pagamento=None) + "\n> **categoria**: assinatura, moradia, contas da casa, serviços, educação, saúde ou outros.\n",
    "meta": fm(tipo="meta_financeira", valor_meta=None, valor_acumulado=0, prazo=None) + "\n## Por que esta meta importa\n",
    "orcamento": fm(tipo="orcamento", categoria=None, valor_previsto=None, mes=None) + "\n> **mes** no formato AAAA-MM (ex.: 2026-11).\n",
    "patrimonio": fm(tipo="patrimonio", categoria=None, valor_estimado=None, instituicao=None) + "\n> Não guarde senhas, tokens ou dados de acesso aqui.\n",
}

E = "00 - Entrada"
CAPTURA = " ".join([
    botao("💡 Ideia", f"{E}/Nova ideia", T["ideia"]),
    botao("✅ Tarefa", f"{E}/Nova tarefa", T["tarefa"]),
    botao("⏰ Lembrete", f"{E}/Novo lembrete", T["lembrete"]),
    botao("🔗 Link", f"{E}/Novo link", T["link"]),
    botao("🍲 Receita", f"{E}/Nova receita", T["receita"]),
    botao("ℹ️ Informação", f"{E}/Nova informação", T["info"]),
    botao("📝 Anotação", f"{E}/Nova anotação", T["anotacao"]),
])

AREAS = [
    ("vida", "01 - Vida/🏡 Minha Vida", "🏡 Minha Vida", "Família, casa, saúde, pets, viagens e rotina."),
    ("trabalho", "02 - Trabalho/⚖️ Trabalho", "⚖️ Trabalho", "Clientes, processos, contratos, reuniões e pendências."),
    ("projetos", "04 - Projetos/🚀 Projetos", "🚀 Projetos", "Negócios, ideias, metas e projetos em andamento."),
    ("conhecimento", "03 - Conhecimento/📚 Conhecimento", "📚 Conhecimento", "Livros, cursos, receitas, estudos e referências."),
    ("financeiro", "06 - Financeiro/💰 Meu Financeiro", "💰 Financeiro", "Contas, orçamento, assinaturas, metas e patrimônio."),
    ("planejamento", "📅 Planejamento", "📅 Planejamento", "Tarefas, compromissos, vencimentos e lembretes."),
    ("entrada", "00 - Entrada/Caixa de Entrada", "📥 Caixa de Entrada", "O que ainda não foi organizado."),
]


def cartoes() -> str:
    linhas = ["> [!sc-grade]"]
    for i, (cls, alvo, titulo, desc) in enumerate(AREAS):
        if i:
            linhas.append(">")
        linhas.append(f"> > [!sc-{cls}] [[{alvo}|{titulo}]]")
        linhas.append(f"> > {desc}")
    return "\n".join(linhas)


def voltar() -> str:
    return "[[🏠 Minha Central|← Minha Central]]"


# ---------------------------------------------------------------- 🏠 Minha Central
ARQ["🏠 Minha Central.md"] = f"""{painel('central')}
> [!sc-cabecalho] 🧠 Meu Segundo Cérebro
> Minha vida, minhas ideias e meus projetos em um só lugar.

> [!sc-captura] ⚡ Captura Rápida
> Toque em um botão: uma nota nova abre na **📥 Entrada**, já com os campos certos.
>
> {CAPTURA}

{cartoes()}

## ☀️ Meu Dia
<span class="sc-dica">Mostra só registros reais: tarefas com <code>prazo</code>, lembretes e compromissos com <code>data</code>, e vencimentos das suas notas.</span>

### Tarefas de hoje
{base('Planejamento', 'Tarefas de hoje')}

### Atrasadas
{base('Planejamento', 'Tarefas atrasadas')}

### Lembretes e compromissos de hoje
{base('Planejamento', 'Hoje - lembretes e compromissos')}

### Próximos vencimentos (30 dias)
{base('Planejamento', 'Vencimentos - próximos 30 dias')}

## 💰 Financeiro do mês
{base('Financeiro', 'Resumo do mês')}

### Contas a pagar
{base('Financeiro', 'Contas a pagar')}

## 🚀 Projetos em andamento
{base('Projetos', 'Em andamento')}

## 📥 Na Caixa de Entrada
{base('Entrada', 'Itens da Entrada')}

## 🔗 Acessos rápidos
> [!sc-atalhos] Ir direto para
> [[01 - Vida/Casa|🏠 Casa]] [[01 - Vida/🏡 Minha Vida#👪 Família|👪 Família]] [[01 - Vida/🏡 Minha Vida#🧑 Pessoas|🧑 Pessoas]] [[01 - Vida/🏡 Minha Vida#🪪 Documentos|🪪 Documentos]] [[03 - Conhecimento/📚 Conhecimento#🍲 Receitas|🍲 Receitas]] [[03 - Conhecimento/📚 Conhecimento#🎓 Estudos|🎓 Estudos]] [[04 - Projetos/🚀 Projetos|🚀 Projetos]] [[06 - Financeiro/💰 Meu Financeiro|💰 Financeiro]] [[00 - Entrada/Caixa de Entrada|📥 Caixa de Entrada]]
"""

# ---------------------------------------------------------------- 🏡 Minha Vida
V = "01 - Vida"
ARQ[f"{V}/🏡 Minha Vida.md"] = f"""{painel('vida')}
{voltar()}

> [!sc-cabecalho] 🏡 Minha Vida
> Família, casa, saúde, pets, viagens e rotina.

> [!sc-captura] ➕ Registrar
> {botao('🧑 Pessoa', f'{V}/Nova pessoa', T['pessoa'])} {botao('🪪 Documento', f'{V}/Novo documento', T['documento'])} {botao('🔧 Equipamento da casa', f'{V}/Novo equipamento', T['equipamento'])} {botao('💉 Saúde do Nicolas', f'{V}/Nicolas - novo registro de saúde', T['saude_nicolas'])} {botao('🩺 Consulta ou exame', f'{V}/Nova consulta', T['saude'])} {botao('🐾 Pet', f'{V}/Novo registro do pet', T['pet'])} {botao('✈️ Viagem', f'{V}/Nova viagem', T['viagem'])}

## 👪 Família
<span class="sc-dica">Pessoas, datas e compromissos da família. Use a propriedade <code>relacao</code> nas notas de pessoa (ex.: marido, filho, mãe).</span>

## 🧑 Pessoas
{base('Vida', 'Pessoas')}

## 👦 Nicolas
<span class="sc-dica">Rotina, consultas, vacinas, desenvolvimento e documentos. Registre só dados de fontes confiáveis (carteirinha, laudos, receitas médicas).</span>

{base('Vida', 'Nicolas')}

## 🏠 Casa
Notas da casa: [[{V}/Casa|🏠 Casa]] · [[{V}/Máquina de Lavar|🧺 Máquina de lavar]]

### Equipamentos, manutenções e garantias
{base('Vida', 'Casa')}

## 🩺 Saúde
{base('Vida', 'Saúde')}

## 🐾 Pets
{base('Vida', 'Pets')}

## ✈️ Viagens
{base('Vida', 'Viagens')}

## 🪪 Documentos
<span class="sc-dica">Uma nota por documento, com o arquivo anexado e os dados nas propriedades (<code>validade</code> entra nos vencimentos).</span>

{base('Vida', 'Documentos')}
"""

# ---------------------------------------------------------------- ⚖️ Trabalho
W = "02 - Trabalho"
ARQ[f"{W}/⚖️ Trabalho.md"] = f"""{painel('trabalho')}
{voltar()}

> [!sc-cabecalho] ⚖️ Trabalho
> Cliente → Processo ou Contrato → Documentos → Tarefas → Histórico

> [!sc-captura] ➕ Registrar
> {botao('👤 Cliente', f'{W}/Novo cliente', T['cliente'])} {botao('📂 Processo', f'{W}/Novo processo', T['processo'])} {botao('📄 Contrato', f'{W}/Novo contrato', T['contrato'])} {botao('🗓️ Reunião', f'{W}/Nova reunião', T['reuniao'])} {botao('⏳ Prazo ou pendência', f'{W}/Novo prazo', T['prazo_trab'])}

> [!sc-secao] Como relacionar as informações
> - Em **processos, contratos, reuniões e prazos**, preencha `cliente` com um link para a nota do cliente, por exemplo `"[[Nome do Cliente]]"`.
> - Na nota do cliente, a seção **"Mencionado em"** (backlinks) mostra tudo que aponta para ele.
> - Documentos originais podem continuar no **Google Drive**: cole o link na nota.
> - Cliente muito sigiloso? Coloque `privado: true` na nota e ela **não vai para a nuvem** nem para as IAs.

## ⏳ Prazos e pendências
{base('Trabalho', 'Prazos e pendências')}

## 👤 Clientes
{base('Trabalho', 'Clientes')}

## 📂 Processos
{base('Trabalho', 'Processos')}

## 📄 Contratos
{base('Trabalho', 'Contratos')}

## 🗓️ Reuniões
{base('Trabalho', 'Reuniões')}

## 📑 Modelos jurídicos
<span class="sc-dica">Guarde aqui seus modelos de peças e contratos (uma nota por modelo, com <code>tipo: modelo_juridico</code>).</span>

{base('Trabalho', 'Modelos jurídicos')}
"""

# ---------------------------------------------------------------- 🚀 Projetos
J = "04 - Projetos"
ARQ[f"{J}/🚀 Projetos.md"] = f"""{painel('projetos')}
{voltar()}

> [!sc-cabecalho] 🚀 Projetos
> Negócios, ideias, metas e projetos.

> [!sc-captura] ➕ Registrar
> {botao('🚀 Novo projeto', f'{J}/Novo projeto', T['projeto'])} {botao('💡 Nova ideia', f'{E}/Nova ideia', T['ideia'])}

> [!sc-secao] Propriedades de um projeto
> `tipo: projeto` · `status`: ideia, planejamento, ativo, pausado ou concluído · `area` · `prioridade`: alta, média ou baixa · `data_inicio` · `prazo`

## 🟢 Em andamento
{base('Projetos', 'Em andamento')}

## ⏸️ Pausados
{base('Projetos', 'Pausados')}

## ✅ Concluídos
{base('Projetos', 'Concluídos')}

## 💡 Ideias
{base('Projetos', 'Ideias')}
"""

# ---------------------------------------------------------------- 📚 Conhecimento
K = "03 - Conhecimento"
ARQ[f"{K}/📚 Conhecimento.md"] = f"""{painel('conhecimento')}
{voltar()}

> [!sc-cabecalho] 📚 Conhecimento
> Livros, estudos, receitas, referências e ideias.

> [!sc-captura] ➕ Registrar
> {botao('📖 Livro', f'{K}/Novo livro', T['livro'])} {botao('🎓 Estudo ou curso', f'{K}/Novo estudo', T['estudo'])} {botao('🍲 Receita', f'{K}/Nova receita', T['receita'])} {botao('🔗 Referência', f'{K}/Nova referência', T['link'])} {botao('💡 Ideia', f'{K}/Nova ideia', T['ideia'])}

## 📖 Livros
{base('Conhecimento', 'Livros')}

## 🎓 Estudos
{base('Conhecimento', 'Estudos')}

## 🍲 Receitas
{base('Conhecimento', 'Receitas')}

## 🔗 Referências
<span class="sc-dica">Artigos, vídeos, sites e conteúdos salvos. No futuro: compartilhar um link pelo iPhone e ele cair aqui.</span>

{base('Conhecimento', 'Referências')}

## 💡 Biblioteca de ideias
{base('Conhecimento', 'Ideias')}
"""

# ---------------------------------------------------------------- 💰 Meu Financeiro
F = "06 - Financeiro"
ARQ[f"{F}/💰 Meu Financeiro.md"] = f"""{painel('financeiro')}
{voltar()}

> [!sc-cabecalho] 💰 Meu Financeiro
> Contas, orçamento, assinaturas, metas e patrimônio.

> [!sc-captura] ➕ Registrar
> {botao('➖ Despesa / conta a pagar', f'{F}/Nova despesa', T['despesa'])} {botao('➕ Receita / a receber', f'{F}/Nova receita', T['receita_fin'])} {botao('🔁 Conta fixa ou assinatura', f'{F}/Nova conta fixa', T['recorrente'])} {botao('🎯 Meta', f'{F}/Nova meta', T['meta'])} {botao('📊 Orçamento da categoria', f'{F}/Novo orçamento', T['orcamento'])} {botao('🏦 Investimento ou bem', f'{F}/Novo patrimônio', T['patrimonio'])}

> [!sc-secao] Como funciona
> - Cada **lançamento** (uma despesa ou receita) é uma nota pequena. Os totais são calculados sozinhos.
> - **Contas fixas e assinaturas** são uma nota só cada uma (não precisa repetir todo mês).
> - **valor**: só números com ponto, ex.: `1250.90`. Datas: `AAAA-MM-DD`.
> - Nada de senhas, tokens bancários ou dados de acesso aqui. Nenhuma conta bancária está conectada.

## 📆 Visão geral do mês
<span class="sc-dica">Receitas e despesas com <code>data</code> neste mês. Na coluna "Saldo", a soma mostra o saldo do mês.</span>

{base('Financeiro', 'Resumo do mês')}

### Gastos por categoria (mês)
{base('Financeiro', 'Gastos por categoria')}

## 💳 Contas a pagar
{base('Financeiro', 'Contas a pagar')}

## 📥 Contas a receber
{base('Financeiro', 'Contas a receber')}

## 🏠 Despesas fixas
{base('Financeiro', 'Despesas fixas')}

## 🔁 Assinaturas
{base('Financeiro', 'Assinaturas')}

## 📊 Orçamento mensal
<span class="sc-dica">Previsto por categoria. Compare com "Gastos por categoria" acima. O Obsidian não cruza as duas tabelas sozinho; o Claude pode calcular a diferença para você.</span>

{base('Financeiro', 'Orçamento')}

## 🎯 Metas financeiras
{base('Financeiro', 'Metas')}

## 🏦 Investimentos e patrimônio
{base('Financeiro', 'Patrimônio')}
"""

# ---------------------------------------------------------------- 📅 Planejamento
ARQ["📅 Planejamento.md"] = f"""{painel('planejamento')}
{voltar()}

> [!sc-cabecalho] 📅 Planejamento
> Tarefas, compromissos, vencimentos e lembretes.

> [!sc-captura] ➕ Registrar
> {botao('✅ Tarefa', f'{E}/Nova tarefa', T['tarefa'])} {botao('⏰ Lembrete', f'{E}/Novo lembrete', T['lembrete'])} {botao('🗓️ Compromisso', f'{E}/Novo compromisso', fm(tipo='compromisso', data=None, hora=None, local=None) + chr(10) + '🗓️ Descreva o compromisso.' + chr(10))}

> [!sc-secao] Importante sobre avisos
> Este painel **mostra** prazos e datas, mas o Obsidian **não envia notificações** para o iPhone sozinho. Os dados já ficam no formato certo para uma automação de lembretes no futuro.
> As datas das notas (ex.: próxima manutenção) **não são** eventos do seu calendário: elas só aparecem aqui.

## ✅ Tarefas
### Hoje
{base('Planejamento', 'Tarefas de hoje')}

### Atrasadas
{base('Planejamento', 'Tarefas atrasadas')}

### Próximos 7 dias
{base('Planejamento', 'Tarefas - próximos 7 dias')}

### Sem prazo
{base('Planejamento', 'Tarefas sem prazo')}

### Concluídas
{base('Planejamento', 'Tarefas concluídas')}

## 🗓️ Compromissos e lembretes
{base('Planejamento', 'Compromissos e lembretes')}

## ⏳ Vencimentos
<span class="sc-dica">Junta automaticamente: <code>proxima_manutencao</code>, <code>vencimento</code>, <code>proxima_dose</code>, <code>validade</code>, <code>proxima_cobranca</code>, <code>garantia_ate</code> e <code>prazo</code> de processos.</span>

### Próximos 30 dias
{base('Planejamento', 'Vencimentos - próximos 30 dias')}

### Atrasados
{base('Planejamento', 'Vencimentos atrasados')}

### Próximos 12 meses
{base('Planejamento', 'Vencimentos - próximos 12 meses')}
"""

# ---------------------------------------------------------------- arquivos .base
SEM_SISTEMA = '    - \'!file.inFolder("05 - Sistema")\'\n'


def tabela(nome, filtros, ordem, extra=""):
    f = "".join(f"        - '{x}'\n" for x in filtros)
    o = "".join(f"      - {x}\n" for x in ordem)
    return f"  - type: table\n    name: \"{nome}\"\n    filters:\n      and:\n{f}    order:\n{o}{extra}"


ARQ[f"{P}/Planejamento.base"] = f"""filters:
  and:
{SEM_SISTEMA}formulas:
  proxima_data: 'if(proxima_manutencao, date(proxima_manutencao), if(vencimento, date(vencimento), if(proxima_dose, date(proxima_dose), if(validade, date(validade), if(proxima_cobranca, date(proxima_cobranca), if(garantia_ate, date(garantia_ate), if(tipo == "processo" && prazo, date(prazo))))))))'
  o_que: 'if(proxima_manutencao, "🔧 Manutenção", if(vencimento, "💳 Vencimento", if(proxima_dose, "💉 Dose", if(validade, "🪪 Validade", if(proxima_cobranca, "🔁 Cobrança", if(garantia_ate, "🛡️ Garantia", if(tipo == "processo", "⚖️ Prazo")))))))'
properties:
  file.name:
    displayName: Nota
  formula.proxima_data:
    displayName: Data
  formula.o_que:
    displayName: O quê
views:
{tabela("Tarefas de hoje", ['tipo == "tarefa"', 'status != "feita"', 'date(prazo) == today()'], ["file.name", "prazo", "area", "status"])}
{tabela("Tarefas atrasadas", ['tipo == "tarefa"', 'status != "feita"', 'date(prazo) < today()'], ["file.name", "prazo", "area", "status"])}
{tabela("Tarefas - próximos 7 dias", ['tipo == "tarefa"', 'status != "feita"', 'date(prazo) > today()', 'date(prazo) <= today() + "7d"'], ["file.name", "prazo", "area", "status"])}
{tabela("Tarefas sem prazo", ['tipo == "tarefa"', 'status != "feita"', '!prazo'], ["file.name", "area", "status"])}
{tabela("Tarefas concluídas", ['tipo == "tarefa"', 'status == "feita"'], ["file.name", "prazo", "area"], "    limit: 20\n")}
{tabela("Hoje - lembretes e compromissos", ['tipo == "lembrete" || tipo == "compromisso"', 'date(data) == today()'], ["file.name", "tipo", "hora", "local"])}
{tabela("Compromissos e lembretes", ['tipo == "lembrete" || tipo == "compromisso"', 'date(data) >= today()'], ["file.name", "tipo", "data", "hora", "local"])}
{tabela("Vencimentos - próximos 30 dias", ['status != "pago"', 'status != "cancelada"', 'formula.proxima_data >= today()', 'formula.proxima_data <= today() + "30d"'], ["file.name", "formula.o_que", "formula.proxima_data"])}
{tabela("Vencimentos atrasados", ['status != "pago"', 'status != "cancelada"', 'formula.proxima_data < today()'], ["file.name", "formula.o_que", "formula.proxima_data"])}
{tabela("Vencimentos - próximos 12 meses", ['status != "pago"', 'status != "cancelada"', 'formula.proxima_data >= today()', 'formula.proxima_data <= today() + "365d"'], ["file.name", "formula.o_que", "formula.proxima_data"])}
"""

ARQ[f"{P}/Projetos.base"] = f"""filters:
  and:
{SEM_SISTEMA}    - 'tipo == "projeto"'
properties:
  file.name:
    displayName: Projeto
views:
{tabela("Em andamento", ['status == "ativo" || status == "planejamento" || status == "em andamento"'], ["file.name", "status", "prioridade", "area", "prazo"])}
{tabela("Pausados", ['status == "pausado"'], ["file.name", "prioridade", "area", "prazo"])}
{tabela("Concluídos", ['status == "concluído" || status == "concluido"'], ["file.name", "area", "prazo"])}
{tabela("Ideias", ['status == "ideia"'], ["file.name", "area", "prioridade"])}
"""

ARQ[f"{P}/Entrada.base"] = f"""filters:
  and:
    - 'file.inFolder("00 - Entrada")'
    - 'file.name != "Caixa de Entrada"'
properties:
  file.name:
    displayName: Item
  file.ctime:
    displayName: Criado em
views:
{tabela("Itens da Entrada", ['file.ext == "md"'], ["file.name", "tipo", "file.ctime"])}
"""

ARQ[f"{P}/Vida.base"] = f"""filters:
  and:
{SEM_SISTEMA}properties:
  file.name:
    displayName: Nota
views:
{tabela("Pessoas", ['tipo == "pessoa"'], ["file.name", "relacao", "aniversario", "telefone"])}
{tabela("Nicolas", ['pessoa == "Nicolas" || file.name.contains("Nicolas")'], ["file.name", "tipo", "evento", "data", "proxima_dose"])}
{tabela("Casa", ['area == "casa"', 'file.name != "Casa"'], ["file.name", "tipo", "status", "ultima_manutencao", "proxima_manutencao", "garantia_ate"])}
{tabela("Saúde", ['tipo == "saude"'], ["file.name", "pessoa", "evento", "data", "profissional"])}
{tabela("Pets", ['tipo == "pet" || area == "pets"'], ["file.name", "evento", "data", "proxima_dose"])}
{tabela("Viagens", ['tipo == "viagem"'], ["file.name", "destino", "data_ida", "data_volta", "status"])}
{tabela("Documentos", ['tipo == "documento"'], ["file.name", "pessoa", "documento", "validade"])}
"""

ARQ[f"{P}/Trabalho.base"] = f"""filters:
  and:
{SEM_SISTEMA}properties:
  file.name:
    displayName: Nota
views:
{tabela("Prazos e pendências", ['tipo == "tarefa"', 'area == "trabalho"', 'status != "feita"'], ["file.name", "prazo", "cliente", "status"])}
{tabela("Clientes", ['tipo == "cliente"'], ["file.name", "status", "contato"])}
{tabela("Processos", ['tipo == "processo"'], ["file.name", "cliente", "numero", "status", "prazo"])}
{tabela("Contratos", ['tipo == "contrato"'], ["file.name", "cliente", "status", "vigencia_ate"])}
{tabela("Reuniões", ['tipo == "reuniao"'], ["file.name", "cliente", "data"])}
{tabela("Modelos jurídicos", ['tipo == "modelo_juridico"'], ["file.name", "file.mtime"])}
"""

ARQ[f"{P}/Conhecimento.base"] = f"""filters:
  and:
{SEM_SISTEMA}properties:
  file.name:
    displayName: Nota
views:
{tabela("Livros", ['tipo == "livro"'], ["file.name", "autor", "status", "nota"])}
{tabela("Estudos", ['tipo == "estudo"'], ["file.name", "tema", "status", "origem"])}
{tabela("Receitas", ['tipo == "receita"'], ["file.name", "categoria", "tempo_preparo", "origem"])}
{tabela("Referências", ['tipo == "referencia"'], ["file.name", "categoria", "url"])}
{tabela("Ideias", ['tipo == "ideia"'], ["file.name", "area", "file.ctime"])}
"""

MES = 'date(data).year == today().year && date(data).month == today().month'
ARQ[f"{P}/Financeiro.base"] = f"""filters:
  and:
{SEM_SISTEMA}formulas:
  saldo: 'if(natureza == "despesa", 0 - valor, valor)'
  progresso: 'if(valor_meta, ((valor_acumulado / valor_meta) * 100).round() + "%")'
  falta: 'if(valor_meta, valor_meta - valor_acumulado)'
properties:
  file.name:
    displayName: Descrição
  formula.saldo:
    displayName: Saldo
  formula.progresso:
    displayName: Progresso
  formula.falta:
    displayName: Falta
views:
{tabela("Resumo do mês", ['tipo == "lancamento"', MES], ["file.name", "natureza", "categoria", "valor", "formula.saldo", "data", "status"], "    summaries:\n      valor: Sum\n      formula.saldo: Sum\n")}
{tabela("Gastos por categoria", ['tipo == "lancamento"', 'natureza == "despesa"', MES], ["file.name", "categoria", "valor"], "    groupBy:\n      property: categoria\n      direction: ASC\n    summaries:\n      valor: Sum\n")}
{tabela("Contas a pagar", ['tipo == "lancamento"', 'natureza == "despesa"', 'status == "pendente"'], ["file.name", "valor", "vencimento", "categoria", "forma_pagamento", "recorrencia"], "    summaries:\n      valor: Sum\n")}
{tabela("Contas a receber", ['tipo == "lancamento"', 'natureza == "receita"', 'status != "recebido"'], ["file.name", "origem", "valor", "data", "status"], "    summaries:\n      valor: Sum\n")}
{tabela("Despesas fixas", ['tipo == "recorrente"', 'categoria != "assinatura"', 'status != "cancelada"'], ["file.name", "categoria", "valor", "periodicidade", "proxima_cobranca"], "    summaries:\n      valor: Sum\n")}
{tabela("Assinaturas", ['tipo == "recorrente"', 'categoria == "assinatura"'], ["file.name", "valor", "moeda", "periodicidade", "proxima_cobranca", "status"])}
{tabela("Orçamento", ['tipo == "orcamento"'], ["file.name", "categoria", "valor_previsto", "mes"], "    summaries:\n      valor_previsto: Sum\n")}
{tabela("Metas", ['tipo == "meta_financeira"'], ["file.name", "valor_meta", "valor_acumulado", "formula.progresso", "formula.falta", "prazo"])}
{tabela("Patrimônio", ['tipo == "patrimonio"'], ["file.name", "categoria", "valor_estimado", "instituicao"], "    summaries:\n      valor_estimado: Sum\n")}
"""

# ---------------------------------------------------------------- modelos novos (não mexe nos existentes)
M = "05 - Sistema/Modelos"
ARQ[f"{M}/Modelo - Tarefa.md"] = T["tarefa"]
ARQ[f"{M}/Modelo - Lançamento financeiro.md"] = T["despesa"]
ARQ[f"{M}/Modelo - Conta fixa ou assinatura.md"] = T["recorrente"]
ARQ[f"{M}/Modelo - Receita.md"] = T["receita"]
ARQ[f"{M}/Modelo - Equipamento ou manutenção.md"] = T["equipamento"]

# ---------------------------------------------------------------- snippet CSS
ARQ[".obsidian/snippets/segundo-cerebro-dashboard.css"] = (Path(__file__).parent / "segundo-cerebro-dashboard.css").read_text()

if __name__ == "__main__":
    if RAIZ.exists():
        shutil.rmtree(RAIZ)
    for caminho, conteudo in ARQ.items():
        alvo = RAIZ / caminho
        alvo.parent.mkdir(parents=True, exist_ok=True)
        alvo.write_text(conteudo, encoding="utf-8")
    print(f"{len(ARQ)} arquivos gerados em {RAIZ}")
    for c in ARQ:
        print(" -", c)
