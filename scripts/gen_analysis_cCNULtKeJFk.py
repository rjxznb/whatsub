# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_cCNULtKeJFk (accounting vocabulary) from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/cCNULtKeJFk/cut_cCNULtKeJFk.clean.vtt'
out_path = 'data/cc-video/banking/cCNULtKeJFk/cut_cCNULtKeJFk.analysis.json'

with open(vtt_path, encoding='utf-8') as f:
    text = f.read()

cue_pattern = re.compile(
    r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)',
    re.DOTALL)

def parse_ts(ts):
    parts = ts.split(':')
    return int(parts[0])*3600 + int(parts[1])*60 + float(parts[2])

cues = []
for match in cue_pattern.finditer(text):
    start = round(parse_ts(match.group(1)), 3)
    end = round(parse_ts(match.group(2)), 3)
    body = match.group(3).strip().replace('\n', ' ')
    cues.append((start, end, body))

translations = [
    "理解会计词汇是学习会计工作原理的重要第一步。让我们来看一些关键术语及其含义。",  # 0
    "日记账（Journal），有时也叫原始记录簿（book of original entry），更常见的叫法是总日记账（general journal），",  # 1
    "是将交易记录输入会计记录的方式。它是公司交易的按时间顺序排列的清单。",  # 2
    "账户（Account）是会计中使用的基本汇总工具。所有与某个特定账户相关的交易都记录在该账户中。",  # 3
    "例如，所有影响现金的交易都会记录在现金账户中。",  # 4
    "账户被分为五大类，包括资产、负债、权益、收入和费用。",  # 5
    "我们稍后会学习财务数据如何从日记账转入账户。",  # 6
    "在学术环境中，账户通常以T型账户（T-account）的形式表示。会计中还有两个非常重要的术语是借方（debit）和贷方（credit）。",  # 7
    "借方（Debit），有时缩写为DR，表示账户的左边。",  # 8
    "贷方（Credit），有时缩写为CR，表示账户的右边。",  # 9
    "就是这样。借方和贷方是不同账户增加或减少的方式，",  # 10
    "但它们本身不等于增加或减少，因为这取决于影响的是哪个账户。",  # 11
    "每笔交易必须影响两个或更多账户，以保持会计等式平衡。我们在学习会计等式时已经了解了这一点。",  # 12
    "这就是所谓的复式记账法（double entry accounting）。所以每笔交易必须至少包含两个账户。",  # 13
    "一个被借记的账户和一个被贷记的账户。可以多于两个账户，但不能少于两个。",  # 14
    "而且借方必须始终等于贷方，否则会计等式就会失衡。",  # 15
    "账户余额要么是借方余额（debit balance），要么是贷方余额（credit balance）。会计中没有负余额。余额的计算方式是",  # 16
    "先分别合计账户的借方和贷方，然后用较大的一方减去较小的一方。",  # 17
    "差额就是较大一方的余额。一个账户只能有一个余额。在这个例子中，",  # 18
    "借方是20,000美元，贷方是9,000美元。所以这个账户的余额是11,000美元的借方余额。",  # 19
    "在下一个例子中，借方是15,000美元，贷方是17,000美元。",  # 20
    "所以这个账户的余额是2,000美元的贷方余额。分类账（Ledger），有时也叫总分类账（general ledger），",  # 21
    "是公司所有账户的集合。所有的资产、负债、权益、收入和费用账户都在分类账中。",  # 22
    "在结束这个关于会计术语的短视频之前，我想重新回顾一些术语，更好地定义这些账户。",  # 23
    "资产（Assets）是经济资源——意味着有价值的东西——由企业拥有或控制，",  # 24
    "并将在未来提供利益。判断某样东西是否为资产的关键",  # 25
    "是资产能提供未来利益。办公用品（Supplies）是一项资产，因为我们还没有使用它们。",  # 26
    "当我们使用后，它们就变成了费用——准确地说是办公用品费用（Supplies expense）。",  # 27
    "它们就变成了过去的利益，不再是未来的利益了。",  # 28
    "应收账款（Accounts receivable）是客户欠我们的钱。如果我们以赊账方式提供服务，",  # 29
    "我们就会在记录该交易时使用应收账款。预付费用（Prepaid expenses）类似于办公用品，它们将成为过去的利益，",  # 30
    "但在那之前，它们是一项资产。负债（Liabilities）是外部方（如债权人）对我们资产的索取权。",  # 31
    "应付账款（Accounts payable）是我们欠供应商的钱。应计负债（Accrued liabilities），有时也叫应计费用，",  # 32
    "是我们因运营活动而欠付的款项。",  # 33
    "例如，已收到但尚未支付的水电费就是一种应计负债（accrued liability）。",  # 34
    "权益（Equity）是内部方（如所有者）对资产的索取权。有时也叫净值（net worth）或净资产（net assets），",  # 35
    "因为它是在负债偿还或清算后剩余的资产价值。",  # 36
    "你可以看到会计等式可以转换为：资产减去负债等于权益，或净值，",  # 37
    "或净资产。留存收益（Retained earnings）是公司保留而未以股息形式支付给股东的利润金额。",  # 38
    "股息（Dividends）是公司作为投资回报支付给股东的利润金额。",  # 39
    "收入（Revenues）是来自运营的流入。它们是公司从经营活动中获得的利益。",  # 40
    "回想一下，收入增加权益，但从技术上讲不是权益账户。服务收入（Service revenue）通过提供服务赚取。",  # 41
    "销售收入（Sales revenue）通过销售商品赚取。费用（Expenses）是运营的流出。",  # 42
    "它们是公司在经营活动中产生的成本。销售成本（cost of goods sold）这个账户名称看起来不像是费用账户。",  # 43
    "对于零售商和制造商来说，它通常是最大的费用项目。它的意思就是",  # 44
    "字面意思——已售商品的成本。这就是本节",  # 45
    "介绍一些基础会计术语和对特定账户更深入了解的短视频的全部内容。",  # 46
]

key_data = {
    1: ("general journal", "总日记账/普通日记账。也叫 book of original entry（原始记录簿）。是所有交易按时间顺序最初记录的地方。注意不要和 ledger（分类账）混淆：journal 是按时间记录，ledger 是按账户分类。", "总日记账"),
    7: ("T-account", "T型账户。学术环境中常用的账户表示形式，因形状像字母T而得名。左边是借方（debit），右边是贷方（credit）。是学习会计记账的基础工具。", "T型账户"),
    8: ("Debit", "借方。缩写为DR。表示账户的左边。注意：debit（借方）不等于「增加」——对资产账户来说借方是增加，但对负债和权益账户来说借方是减少。", "借方"),
    13: ("double entry accounting", "复式记账法。会计的基本原则：每笔交易必须至少影响两个账户，一个借记一个贷记，保持会计等式（Assets = Liabilities + Equity）平衡。", "复式记账法"),
    16: ("debit balances", "借方余额。账户的余额类型。如果借方合计大于贷方合计，则为借方余额。资产和费用账户通常有借方余额。会计中没有「负余额」的概念。", "借方余额"),
    21: ("general ledger", "总分类账。是公司所有账户的集合——包括资产、负债、权益、收入和费用账户。与 journal（日记账）的区别：journal 按时间记录交易，ledger 按账户分类汇总。", "总分类账"),
    24: ("Assets", "资产。由企业拥有或控制的经济资源，能在未来提供利益。关键判断标准：能否提供未来利益（future benefits）。例：现金、应收账款、设备等。", "资产"),
    29: ("Accounts receivable", "应收账款。客户欠我们的钱。当以赊账方式（on account）提供服务或销售商品时使用。属于资产类账户，因为代表未来将收到的现金。", "应收账款"),
    30: ("Prepaid expenses", "预付费用。提前支付但尚未使用的费用，如预付租金、预付保险。在使用之前属于资产（未来利益），使用后转为费用（过去利益）。", "预付费用"),
    31: ("Liabilities", "负债。外部方（如债权人、供应商）对企业资产的索取权。与权益（Equity）的区别：负债是外部方的索取权，权益是内部方（所有者）的索取权。", "负债"),
    32: ("Accounts payable", "应付账款。我们欠供应商（vendors/suppliers）的钱。与应收账款（Accounts receivable）相反：AR是别人欠我们的，AP是我们欠别人的。", "应付账款"),
    35: ("Equity", "权益/所有者权益。内部方（所有者）对资产的索取权。也叫 net worth（净值）或 net assets（净资产），因为等于资产减去负债后的剩余价值。", "权益"),
    38: ("Retained earnings", "留存收益。公司保留而未以股息形式分配给股东的利润。它是联系利润表和资产负债表的关键项目。计算：期初留存收益 + 净利润 - 股息 = 期末留存收益。", "留存收益"),
    39: ("Dividends", "股息/红利。公司作为投资回报支付给股东的利润。注意：股息减少留存收益（Retained earnings），但不是费用（Expense）。", "股息"),
    42: ("Expenses", "费用。运营活动中的流出/成本。与资产的区别：资产提供未来利益，费用是已消耗的利益（过去利益）。例：租金费用、工资费用、办公用品费用等。", "费用"),
    43: ("cost of goods sold", "销售成本/已售商品成本。对零售商和制造商来说通常是最大的费用项目。虽然名称中没有「expense」，但它确实是一个费用账户。缩写COGS。", "销售成本"),
}

subs = []
for i, (start, end, txt) in enumerate(cues):
    sub = {
        "time": start,
        "endTime": end,
        "text": txt,
        "translation": translations[i] if i < len(translations) else "",
        "isKeyPoint": i in key_data,
        "highlightWords": [key_data[i][0]] if i in key_data else [],
        "keyNotes": {key_data[i][0]: key_data[i][1]} if i in key_data else {},
        "highlightTranslations": {key_data[i][0]: key_data[i][2]} if i in key_data else {},
    }
    subs.append(sub)

data = {
    "sceneContext": "The user is a student learning foundational accounting vocabulary with a professor. They need to understand key accounting terms including journal, account, debit, credit, T-account, double entry accounting, ledger, and the five account categories (assets, liabilities, equity, revenues, expenses) along with specific account types like accounts receivable, accounts payable, and retained earnings.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "general journal", "meaningZh": "总日记账", "usage": "The book where all transactions are initially recorded in chronological order", "register": "professional", "speakerRole": "passive", "minDifficulty": "EASY"},
        {"expression": "double entry accounting", "meaningZh": "复式记账法", "usage": "The fundamental accounting principle that every transaction affects at least two accounts", "register": "professional", "speakerRole": "passive", "minDifficulty": "EASY"},
        {"expression": "debit and credit", "meaningZh": "借方和贷方", "usage": "The two sides of every account — debit is left, credit is right", "register": "professional", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "accounts receivable", "meaningZh": "应收账款", "usage": "Money owed to the company by its customers for services or goods provided on account", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "accounts payable", "meaningZh": "应付账款", "usage": "Money the company owes to its vendors or suppliers", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "retained earnings", "meaningZh": "留存收益", "usage": "Profits kept by the company rather than distributed as dividends to stockholders", "register": "professional", "speakerRole": "passive", "minDifficulty": "MEDIUM"},
        {"expression": "cost of goods sold", "meaningZh": "销售成本", "usage": "The expense account for the cost of products sold, often the largest expense for retailers", "register": "professional", "speakerRole": "passive", "minDifficulty": "HARD"},
        {"expression": "general ledger", "meaningZh": "总分类账", "usage": "The complete collection of all company accounts organized by category", "register": "professional", "speakerRole": "passive", "minDifficulty": "MEDIUM"},
        {"expression": "assets and liabilities", "meaningZh": "资产与负债", "usage": "Two of the five major account categories — assets are economic resources, liabilities are external claims", "register": "professional", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "prepaid expenses", "meaningZh": "预付费用", "usage": "Payments made in advance that are assets until consumed, then become expenses", "register": "professional", "speakerRole": "passive", "minDifficulty": "HARD"},
    ],
    "roleSetup": {"name": "Professor Adams", "identity": "Accounting professor at a university", "personality": "clear, methodical, patient", "accent": "American"},
    "complications": {
        "medium": [
            "The student confuses debit with 'increase' — needs to understand that debit means left side, and its effect depends on the account type",
            "The student mixes up accounts receivable and accounts payable"
        ],
        "hard": [
            "The student must explain why supplies start as an asset and become an expense, demonstrating understanding of future vs past benefits",
            "The student needs to journalize a transaction using double entry accounting with correct debit and credit entries"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "把 debit 等同于「增加」、credit 等同于「减少」——实际取决于账户类型",
        "混淆 accounts receivable（别人欠我们的）和 accounts payable（我们欠别人的）",
        "混淆 journal（按时间记录）和 ledger（按账户分类）的区别",
        "把 dividends 当作费用（expense）——股息减少留存收益但不是费用"
    ],
    "culturalNotes": "会计是商科专业的基础课程，在美国大学中几乎所有商学院学生都需要学习。理解这些基本术语是后续学习财务会计、管理会计和审计的前提。美国会计准则（GAAP）和国际会计准则（IFRS）在术语使用上基本一致，但某些处理方法有差异。",
    "country": "US"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
