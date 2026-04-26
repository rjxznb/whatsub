# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_yDyKmzC-H3U (Canadian banks for newcomers) from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/yDyKmzC-H3U/cut_yDyKmzC-H3U.clean.vtt'
out_path = 'data/cc-video/banking/yDyKmzC-H3U/cut_yDyKmzC-H3U.analysis.json'

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
    "大家好，在这个视频里我会告诉你们加拿大新移民可以选择的银行，介绍排名前五的加拿大银行以及它们能提供什么服务。",  # 0
    "Lancer（观众）提了一个有意思的问题：能不能在抵达加拿大之前就开好银行账户？开账户需要多长时间？",  # 1
    "以及需要哪些文件？Lancer，这个视频里我都会一一讲清楚。好的，首先",  # 2
    "最重要的一点，那个有意思的问题：可以在抵达加拿大之前开银行账户吗？可以的，但前提是你已经拿到永久居民的",  # 3
    "确认函（COPR）。这是针对permanent residence（永久居民）的。所有的国际学生也可以在抵达加拿大之前开户，",  # 4
    "前提是他们已经拿到student visa（学生签证）。国际劳工也可以开户，",  # 5
    "前提是拿到了work permit（工作许可证）。再说一下关于永久居民的情况，",  # 6
    "你必须拿到COPR（Confirmation of Permanent Residence），上面有不同的身份识别号码，比如申请号和其他一些号码。只有这样你才能在加拿大开",  # 7
    "银行账户。好，现在来说排名前五的银行，",  # 8
    "提供这项服务的银行，第一家是",  # 9
    "BMO（Bank of Montreal，蒙特利尔银行）。第二家是RBC，第三家是CIBC，接着是TD，最后是",  # 10
    "Scotiabank（丰业银行）。这些银行都提供在抵达加拿大之前开户的服务。",  # 11
    "我会带你们去这些银行的网站看看，给你们展示",  # 12
    "他们各自提供什么服务。但在这之前，我们先看看需要哪些文件。首先你需要你的passport（护照），也就是你的travel document（旅行证件）。",  # 13
    "然后是你的COPR，上面有所有的参考号码，我记得有两三种不同的号码。还有你的CIN number（实际应为SIN社会保险号）。CIN number是",  # 14
    "你只有在抵达加拿大之后才能拿到的。所以你可以在抵达之前开银行账户，但账户会被冻结（frozen），",  # 15
    "直到你到达加拿大。你可以提前把一些钱transfer（转账）到这个账户里，但显然在到达之前你不能取出任何钱",  # 16
    "账户会一直被冻结，直到你亲自去银行网点（visit the branch）并提供所有这些文件。然后你才能拿到",  # 17
    "debit card（借记卡）、credit card（信用卡）、支票本（checkbook），当然也才能取款和进行各种交易。好的，现在让我们快速",  # 18
    "过一下这五家银行的网站，看看它们都能提供什么服务。",  # 19
]

key_data = {
    4: ("permanent residence", "永久居民身份。加拿大移民的一种身份，简称PR。在获得 Confirmation of Permanent Residence (COPR) 后，即使还未抵达加拿大，也可以凭此开立银行账户。PR 与 citizenship（公民身份）不同，但享有几乎所有权利。", "永久居民"),
    5: ("student visa", "学生签证。国际学生赴加拿大学习所需的签证。拿到 student visa 后，可以在抵达加拿大之前就开始办理银行账户。加拿大的学生签证实际叫 study permit（学习许可）。", "student visa"),
    6: ("work permit", "工作许可证。国际劳工在加拿大合法工作所需的文件。获得 work permit 后即可在抵达前开立银行账户。注意：work permit 和 work visa 在加拿大语境中基本等同。", "work permit"),
    7: ("COPR", "Confirmation of Permanent Residence 的缩写，即「永久居民确认函」。IRCC（加拿大移民部）签发的文件，上面有申请号和识别号码。是 PR 登陆加拿大的关键文件，也是开户必需材料。", "COPR"),
    10: ("BMO", "Bank of Montreal 的缩写，蒙特利尔银行。加拿大五大银行之一，历史悠久（成立于1817年）。加拿大五大银行：RBC（皇家银行）、TD（道明银行）、Scotiabank（丰业银行）、BMO（蒙特利尔银行）、CIBC（帝国商业银行）。", "BMO"),
    14: ("CIN number", "注意：视频中说的「CIN number」实际应为 SIN number（Social Insurance Number，社会保险号）。SIN 是9位数字，加拿大居民的唯一身份识别号，用于工作、税务、银行等。只能在抵达加拿大后在 Service Canada 办理。", "CIN number"),
    17: ("visit the branch", "亲自到银行网点办理。在加拿大开户有一个特殊流程：即使你在抵达前已经线上开户，账户仍会被「冻结」（frozen），只有你亲自去银行分行（branch）出示所有文件后，账户才会激活。", "亲自去银行网点"),
    18: ("debit card", "借记卡。在加拿大，debit card 也叫 Interac card（因为使用 Interac 系统）。开户激活后会拿到借记卡、信用卡和支票本（checkbook）。加拿大仍然广泛使用支票，这一点和其他国家不同。", "debit card"),
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
    "sceneContext": "The user is a newcomer to Canada (international student, worker, or permanent resident) who wants to open a Canadian bank account. They are speaking with a newcomer banking specialist at one of Canada's major banks, asking about eligibility, required documents (passport, COPR, SIN), and whether they can open an account before landing in Canada.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "open a bank account before landing", "meaningZh": "在抵达之前开户", "usage": "A common service for Canadian newcomers allowing pre-arrival account setup", "register": "professional", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "permanent residence", "meaningZh": "永久居民身份", "usage": "Canadian PR status that qualifies you for banking services before arrival", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "student visa", "meaningZh": "学生签证", "usage": "Required for international students — called 'study permit' in Canadian terminology", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "work permit", "meaningZh": "工作许可证", "usage": "Required document for international workers in Canada", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "COPR", "meaningZh": "永久居民确认函", "usage": "Confirmation of Permanent Residence document issued by IRCC, essential for PR landing and banking", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "SIN number", "meaningZh": "社会保险号", "usage": "Social Insurance Number — Canada's 9-digit ID for tax, work, and banking", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "travel document", "meaningZh": "旅行证件", "usage": "Formal term for passport or equivalent identification for international travel", "register": "professional", "speakerRole": "passive"},
        {"expression": "visit the branch", "meaningZh": "亲自去银行网点", "usage": "Going to a physical bank location to complete account activation", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "account is frozen", "meaningZh": "账户被冻结", "usage": "Status of a pre-arrival account until in-person verification is completed", "register": "professional", "speakerRole": "passive"},
        {"expression": "transfer money to the account", "meaningZh": "往账户转钱", "usage": "Moving funds into your new Canadian account before arrival", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ],
    "roleSetup": {"name": "Michael", "identity": "Newcomer banking specialist at a major Canadian bank (RBC)", "personality": "welcoming, informative, professional", "accent": "Canadian"},
    "complications": {
        "medium": [
            "The user is a permanent resident applicant who has their COPR but hasn't landed yet, and needs to understand what they can and cannot do with a pre-arrival account",
            "The user confuses SIN (Social Insurance Number) with other government IDs and doesn't know where to get one"
        ],
        "hard": [
            "The user needs to choose between the Big Five banks (RBC, TD, Scotiabank, BMO, CIBC) based on their newcomer programs and asks about fees, branch locations, and newcomer promotions",
            "The user has already transferred money to the pre-arrival account but now realizes the account is frozen and needs to know exactly what documents to bring to the branch"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "混淆 student visa 和 study permit——加拿大的学生签证官方叫 study permit",
        "不知道 SIN number 只能在抵达加拿大后在 Service Canada 办理，无法在国内获得",
        "以为线上开户后账户可以立即使用——实际上账户会 frozen 直到你亲自到 branch 出示文件",
        "把加拿大五大银行的缩写搞混：RBC、TD、BMO、CIBC、Scotiabank"
    ],
    "culturalNotes": "加拿大五大银行（Big Five Banks）都有专门针对新移民的 newcomer banking program，通常提供免月费、免转账费等优惠长达12个月。很多银行允许你在抵达加拿大之前就通过线上或电话开户，但账户在你亲自去分行激活前会被冻结。建议新移民落地后第一周内完成：①激活银行账户 ②申请 SIN ③办理信用卡建立信用记录。",
    "country": "CA"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
