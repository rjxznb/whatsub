# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_k3acjwyGeRo (opening first bank account) from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/k3acjwyGeRo/cut_k3acjwyGeRo.clean.vtt'
out_path = 'data/cc-video/banking/k3acjwyGeRo/cut_k3acjwyGeRo.analysis.json'

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
    "嘿大家好！我叫David，今天的视频我要讲一个在学校经常学不到的东西——如何开你的第一个",  # 0
    "银行账户。也许你在读高中，正在考虑开你的第一个银行账户；也许你在上大学；也许你是家长，在帮孩子找",  # 1
    "开第一个银行账户的方法；或者你可能年纪更大一些。无论你处于人生的哪个阶段，学校不一定教你的一件事就是如何",  # 2
    "开你的第一个银行账户。今天这个视频我就来教你怎么做。在正式开始之前，我们先来过几个简单的定义。第一个",  # 3
    "是debit（借记）。什么是借记？借记就是从你的账户中取钱。想想借记卡——当你刷借记卡时，它会从你的账户里扣钱然后支付给",  # 4
    "你付款的对象。第二个词是credit（贷记/存入）。贷记就是往你的账户里存钱。可以想成你获得了某种退款或补偿——",  # 5
    "钱回到了你的账户里。第三个是deposit（存款）。存款就是把你手上的现金、支票之类的",  # 6
    "放入你的账户作为一笔贷记。第四个是transaction（交易）。交易就是你去加油站、用支票付房租、或者去",  # 7
    "杂货店刷卡之类的行为。交易是你、商家和你的银行之间的一个协议——你刷了20美元的卡，",  # 8
    "银行从你的账户扣除这笔钱并付给商家，银行收取少量手续费。先把这些定义说清楚，这样我们在讨论",  # 9
    "开第一个银行账户时可能遇到的问题时就在同一个频道上了。现在你准备好了，我们来谈谈首先需要做什么。开银行账户有几件事要注意，",  # 10
    "第一个是fees（费用）。你要明白，银行是一门生意。他们要赚钱、付工资、付营销费用、付建筑物的租金。如果你用的是一家有实体网点的银行，",  # 11
    "他们还要付管理费用和利润。所以这些机构是在赚钱的，其中一种方式就是收费。当你开",  # 12
    "支票账户和储蓄账户时，尤其是支票账户，你要看一下他们免除月费的条件是什么。通常你去开户时",  # 13
    "在他们网站上会看到类似的内容：除非你有自动直接存款（direct deposit），否则我们每月收你15美元。也就是你需要有雇主的",  # 14
    "自动工资存入，或者你有一定数量的交易，或者你保持一定的最低余额（minimum balance）。你要看看这些条件，确保你每个月都能轻松满足。",  # 15
    "你不想总是在临界线上，因为你最不想做的事就是每个月白给银行15美元或其他费用。第二件事是你要了解",  # 16
    "一些罚款性的费用。例如，你绝对不想让账户透支（overdraft），你要注意这些事情。这些费用虽然不可避免，但可以通过",  # 17
    "随时关注你的余额来避免，这个我们稍后会讲，确保你知道如何正确管理。第二个我想",  # 18
    "提到的是interest rates（利率）。比如，如果你的银行账户里有100美元，储蓄账户的利率是1%，每年银行会付给",  # 19
    "你1美元。他们之所以付给你这1美元，是因为他们拿你的100美元去贷给别人，收取3%、4%、5%甚至更高的利率。他们赚取差价然后付给你利息。所以你要确保",  # 20
    "随时关注你的账户和那个1%。通常对于储蓄账户，如果你看的是美国银行、富国银行或你当地的银行，",  # 21
    "储蓄账户的利率通常非常低。你应该寻找1.5%、1.6%甚至1.8%的利率，取决于你的",  # 22
    "储蓄账户余额有多少。我马上会讲如何找到这样的银行。在选择银行时，另一个你经常要考虑的是",  # 23
    "银行的位置。这对你重要吗？你需要去取现金、存款、或者去和银行柜员聊天吗？对我个人来说这不太重要。我的日常",  # 24
    "支票账户在美国银行（Bank of America），我所有其他的储蓄都在一家叫Ally的银行。如果你不太了解银行业，你可能没听过",  # 25
    "他们。他们做的广告不多，但Ally是一家很棒的在线银行（online bank）。它和其他银行有相同的保险保障，在这个视频录制时（2020年2月），利率大约是1.6%。",  # 26
    "储蓄账户可以获得不少收益，利率还不错，而且没有任何费用。你可能听别人说过关于在在线银行开",  # 27
    "支票账户的问题：你不能取现金，有些功能受限。但这些银行通常会报销你在外面",  # 28
    "的ATM交易费用。如果你去另一家银行或加油站取钱，这些银行通常会报销一定金额。所以选银行时一定要了解这些。我个人的建议（没有赞助），",  # 29
    "是选一家地区性银行、credit union（信用合作社）或当地银行来做你的日常支票账户，",  # 30
    "然后用一个high yield savings account（高收益储蓄账户），比如Ally Bank或Capital One来存你的储蓄。",  # 31
    "说到开银行账户实际需要什么，其实很简单。你需要proof of ID（身份证明），比如驾照之类的，",  # 32
    "来证明你是美国公民或所在国家的居民，验证你的身份。所以你一定要确保带上身份证件。",  # 33
    "第二样东西是proof of address（地址证明）。你可以打电话给银行或查看他们的网站看看需要什么，通常他们会要求验证你的家庭",  # 34
    "地址。第三样是你需要填写某种application form（申请表）。他们会问你的年龄、出生日期、法定姓名、",  # 35
    "对账户的期望等等。你要知道你需要填写申请表。如果你去银行的话，他们通常会给你一份纸质表格。如果你用的是",  # 36
    "在线银行，一般在网上填写就行。你需要的第四样东西是",  # 37
    "initial deposit（初始存款）。如果你还没有钱，可能暂时不需要去开户。但即使你只有100或200美元，也足够去开户了。",  # 38
    "如果你去银行的话，确保带上现金或支票之类的。如果你用在线银行，通常可以邮寄支票或从其他账户转入。",  # 39
    "有了这些信息，这就是你开第一个银行账户所需要的一切了。通常可能需要几天时间来处理和开通，但之后你就有了银行",  # 40
    "账户。但接下来呢？注册完之后该做什么？我们来谈谈。你会收到的第一样东西叫debit card（借记卡）。借记卡",  # 41
    "就像你看到别人用的那种信用/借记卡，用来进行交易。它允许你去任何接受信用卡的地方——基本上到处都接受——",  # 42
    "刷卡交易。记住，你用借记卡刷的每一笔消费，你的账户里必须有足够的余额来支付。这是一个很好的工具，",  # 43
    "开户后注意查收邮寄来的借记卡。你要做的第二件事是设置online account（网上银行账户）。",  # 44
    "每家银行的设置方式不同，但他们会给你一个在线ID和某种密码供你设置。我强烈建议的一件事是",  # 45
    "下载银行的手机App。这样你就可以追踪你的交易、",  # 46
    "余额。你甚至可以在手机上设置提醒来随时关注。你也可以在电脑上操作之类的。但我绝对建议你",  # 47
    "在手机上设置好。特别是刚开始积累余额的时候，你不想觉得不了解自己的财务状况。另一件开好账户后要做的事是，如果你有工作的话，",  # 48
    "你要设置所谓的direct deposit（工资直接存入/直接存款），和你的雇主说好。意思是不用寄纸质支票到你家，雇主会直接把工资存入",  # 49
    "你的银行账户。这确实是最好的方式，因为可以避免延迟，也不用亲自去银行办理。钱会直接到账。我绝对建议设置",  # 50
    "直接存款，如果你的雇主提供这个选项的话。第四件你要做的事是把这个银行账户当作开始追踪你的开支和预算的工具。现在你有了银行账户，",  # 51
    "有了固定周期的收入——也许是生日钱、圣诞钱、或你其他来源的收入。",  # 52
    "你要开始利用这个机会来budget your spending（做预算）。追踪收入和支出，这样你就能开始把钱转入储蓄账户。",  # 53
    "大概就是这样了。开银行账户没有你想的那么可怕。这件事每天可能被做成百上千、甚至数万次。",  # 54
    "一旦你熟悉了，你都不会记得没有银行账户是什么感觉了。如果你比较年轻，有一个建议",  # 55
    "在你去开户之前要知道：开一个普通支票账户，通常最低年龄是14岁。具体取决于你所在的州和国家，所以",  # 56
    "请仔细确认。但通常开银行账户的最小年龄是14岁。等你满18岁后，你就可以成为账户的唯一持有人。在14到18岁之间，",  # 57
    "账户上会有你和一位家长或监护人。从18岁开始，你就可以完全拥有自己的银行账户了。",  # 58
]

key_data = {
    4: ("debit", "借记/扣款。在银行语境中，debit 指从账户中取出或扣除资金。debit card（借记卡）刷卡时直接从你的账户余额扣款。与 credit（存入/贷记）相反。发音 /ˈdebɪt/。", "debit（借记）"),
    5: ("credit", "贷记/存入。在银行语境中，credit 指往账户中存入资金。注意这里的 credit 与「信用卡」的 credit 含义不同。当你收到退款或工资时，银行会说 credit to your account。", "credit（贷记/存入）"),
    6: ("deposit", "存款。把现金、支票等存入银行账户。可作名词和动词使用。make a deposit = 存一笔款。initial deposit = 开户时的初始存款。发音 /dɪˈpɒzɪt/。", "deposit（存款）"),
    7: ("transaction", "交易。你和商家之间通过银行完成的任何一笔消费行为。例：每次刷卡、转账、取现都是一笔 transaction。银行对账单上会列出所有 transactions。", "transaction（交易）"),
    11: ("fees", "费用/手续费。银行可能收取的各种费用。常见的有：monthly fee（月费）、overdraft fee（透支费）、ATM fee（ATM手续费）。开户前一定要了解银行的收费标准。", "fees（费用）"),
    14: ("direct deposit", "工资直接存入/直接存款。雇主直接将工资电子转入你的银行账户，无需纸质支票。许多银行要求设置 direct deposit 才能免除月费。", "direct deposit"),
    15: ("minimum balance", "最低余额。银行要求你账户中必须保持的最低金额。如果余额低于这个数字，可能会被收取月费。例：Some banks require a minimum balance of $1,500 to waive monthly fees.", "最低余额"),
    17: ("overdraft", "透支。账户余额不足时仍进行消费导致余额为负。银行会收取 overdraft fee（透支费），通常25-35美元。一定要随时关注余额避免透支。", "overdraft"),
    19: ("interest rates", "利率。银行为你的存款支付的利息百分比。储蓄账户有利率，银行用你的钱去放贷赚更高利率，然后把一小部分利息付给你。大银行利率通常很低，在线银行利率更高。", "interest rates"),
    26: ("online bank", "在线银行/网络银行。没有实体网点的银行，如Ally、Capital One等。优点：利率更高、费用更少。缺点：不能直接去柜台取现金或存款（但通常会报销ATM费用）。", "online bank"),
    30: ("credit union", "信用合作社。会员所有的非营利金融机构，通常比大银行提供更低的费用和更好的利率。适合做日常支票账户。与商业银行的区别：credit union 是会员共同拥有的。", "credit union"),
    31: ("high yield savings account", "高收益储蓄账户。利率远高于普通储蓄账户的账户类型，通常由在线银行提供。例如Ally Bank在2020年提供约1.6%的年利率，而大银行可能只有0.01%。", "high yield savings account"),
    32: ("proof of ID", "身份证明。开银行账户所需的证件，如驾照（driver's license）、护照或州ID。用来验证你的身份和公民身份。留学生可以用护照和I-20表格。", "proof of ID"),
    34: ("proof of address", "地址证明。开户时银行要求的文件，用来验证你的住址。常见的地址证明有：水电账单（utility bill）、租房合同（lease agreement）、银行对账单等。", "proof of address"),
    35: ("application form", "申请表。开户时需要填写的表格，包含个人信息如姓名、出生日期、联系方式等。可以在银行柜台填写纸质表格，也可以在线提交。", "application form"),
    38: ("initial deposit", "初始存款。开户时存入的第一笔钱。大多数银行要求最少25-100美元的初始存款。可以用现金、支票或从其他账户转入。", "initial deposit"),
    41: ("debit card", "借记卡。开支票账户后银行寄给你的卡片，用于日常消费和ATM取款。刷卡时直接从账户余额扣款。与 credit card 不同：debit card 花的是你自己的钱。", "debit card"),
    49: ("direct deposit", "工资直接存入。让雇主直接将工资电子转入你的银行账户。好处：①避免邮寄延迟 ②不用亲自去银行 ③很多银行要求有 direct deposit 才免月费。开户后尽快和雇主设置。", "direct deposit"),
    53: ("budget your spending", "做预算/管理开支。开户后最重要的习惯之一：追踪每月的收入和支出（tracking what's coming in and going out），然后把多余的钱转入储蓄账户。", "budget your spending"),
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
    "sceneContext": "The user is visiting a bank for the first time to open a checking account. They are speaking with a personal banking advisor who will explain basic banking terms, help them choose the right account type, guide them through the required documents, and set up their account with direct deposit and online banking.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "checking account", "meaningZh": "支票账户", "usage": "The most common type of bank account for daily spending, receiving salary, and paying bills", "register": "professional", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "savings account", "meaningZh": "储蓄账户", "usage": "An account designed for saving money that earns interest over time", "register": "professional", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "direct deposit", "meaningZh": "工资直接存入", "usage": "Having your employer deposit your paycheck electronically into your bank account", "register": "professional", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "minimum balance", "meaningZh": "最低余额", "usage": "The lowest amount you must keep in your account to avoid monthly fees", "register": "professional", "speakerRole": "passive"},
        {"expression": "overdraft", "meaningZh": "透支", "usage": "When you spend more money than you have in your account, resulting in a negative balance and fees", "register": "professional", "speakerRole": "passive"},
        {"expression": "interest rate", "meaningZh": "利率", "usage": "The percentage a bank pays you on your savings, or charges you on a loan", "register": "professional", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "proof of ID", "meaningZh": "身份证明", "usage": "Documentation needed to verify your identity when opening a bank account", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "initial deposit", "meaningZh": "初始存款", "usage": "The first amount of money you put into a new bank account", "register": "professional", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "credit union", "meaningZh": "信用合作社", "usage": "A member-owned financial institution that often offers lower fees and better rates than commercial banks", "register": "professional", "speakerRole": "passive"},
        {"expression": "budget your spending", "meaningZh": "做预算/管理开支", "usage": "Tracking income and expenses to manage your money effectively", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ],
    "roleSetup": {"name": "Sarah", "identity": "Personal banking advisor at a local bank", "personality": "helpful, thorough, patient", "accent": "American Female"},
    "complications": {
        "medium": [
            "The user doesn't understand the difference between debit and credit, and confuses which one adds and which removes money",
            "The user wants to open an account but doesn't have a direct deposit set up yet and worries about monthly fees"
        ],
        "hard": [
            "The user needs to compare checking accounts, savings accounts, and high-yield savings accounts to decide the best combination for their situation",
            "The user is under 18 and needs to understand what a joint account with a parent means and when they can get their own independent account"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "混淆 debit（扣款）和 credit（存入）的方向——debit 是从账户扣钱，credit 是存钱进去",
        "不知道 overdraft 会产生高额费用——透支一次可能被罚 25-35 美元",
        "以为所有储蓄账户利率都一样——在线银行的 high yield savings account 利率远高于大银行",
        "不了解开户所需文件——proof of ID、proof of address、initial deposit 是基本三件套"
    ],
    "culturalNotes": "在美国，银行账户几乎是生活必需品——从接收工资到网上购物都需要。建议同时开一个 checking account（日常消费）和一个 high yield savings account（存钱赚利息）。Credit union（信用合作社）是很多美国人的首选，因为费用低、服务好。留学生到美国后应尽快开户，大多数大学附近都有欢迎国际学生的银行。",
    "country": "US"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
