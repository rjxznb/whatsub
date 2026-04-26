# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_dlDnOyrpm9E (opening a bank account) from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/dlDnOyrpm9E/cut_dlDnOyrpm9E.clean.vtt'
out_path = 'data/cc-video/banking/dlDnOyrpm9E/cut_dlDnOyrpm9E.analysis.json'

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
    "你想开一个银行账户？太好了，因为今天我要告诉你开银行账户到底是什么意思。我会解释借记卡、信用卡，还会在电脑上一步步演示如何开户。",  # 0
    "这就是为什么我坐在这里……不，其实是绿幕，但我会用它来一步步带你们操作，非常简单。让我们开始吧。",  # 1
    "好的，我希望你们打开Chase银行的网站或者你喜欢的任何银行。我就喜欢Chase。我来说说我们具体要做什么。",  # 2
    "我们要开的是一个checking account（支票账户）或者叫debit account（借记账户），两者是同一个东西。如果你不知道什么是借记账户，它基本上就是一个可以用来购物的账户，",  # 3
    "你会用到一种叫debit card（借记卡）的东西。这是我的借记卡，请别偷我的信息。开了支票账户后，他们会把借记卡邮寄给你。你就可以拿着它去商店消费，",  # 4
    "当你有了工作后，雇主会把工资存入这个支票账户。这样你就可以花钱、享受支票账户带来的各种便利了，对吧？",  # 5
    "还有一种东西叫credit card（信用卡），对吧？比如这是我的信用卡，Navy Federal信用卡。它和支票账户不太一样。",  # 6
    "更像是你账户里有一笔额度，你随时可以使用，但用了之后你必须pay that balance back（还清这笔钱）。现在让我一步步教你怎么开自己的银行账户。",  # 7
    "我们现在在Chase网站上。记住，你可以选择任何银行。我喜欢Chase。主页上写着开新支票账户送200美元，我们就点「开户」。",  # 8
    "顺便说一下，这不是广告，我只是想教你们一些知识。好的，点这里开户。开户并不难，它会要求你提供social security number（社会安全号）、驾照或state ID（州身份证）。",  # 9
    "就长这个样子。如果你没有，可以在UPS办事处轻松办一个。这是我的，就这样。你也可以用社会安全号。我不能告诉你们我的号码，",  # 10
    "因为你们真的会偷我的信息。如果你未满18岁，也可以开银行账户。方法如下：这里有一个添加joint applicant（联名申请人）的选项。",  # 11
    "意思是如果你想在18岁以下开银行账户，你的父母需要在这一步替你申请。如果你父母已满18岁——显然他们肯定满了，",  # 12
    "不然就太奇怪了——他们会和你一起去银行，或者在网上操作，把你添加为联名申请人。这样即使你只有15岁，",  # 13
    "16岁，你也能拥有自己的银行账户。太酷了。但如果不这样做的话，你必须年满18岁才能自己开户。很遗憾，如果你未满18岁，没有其他方式开户。",  # 14
    "有一些很奇怪的App可以试试，但我真的不放心把个人信息交给它们。然后你只需要填写这些信息，接着它会问你是否是美国公民。你显然在美国，",  # 15
    "就选「是」。如果你不是美国人，也可以开户，只是需要选「否」然后完成额外步骤。你的社会安全号，你需要输入社会安全号。",  # 16
    "通常是九位数。你可以让父母把卡给你，或者直接告诉你号码。如果你没有社会安全号就奇怪了，在美国每个人都应该有。接下来它会要求我们提供身份证件。",  # 17
    "我就用驾照。关于财务状况的问题——大家别紧张，这个调查不重要。我就填我是一名学生兼企业主。",  # 18
    "我就填表演艺术公司，因为选项里根本没有YouTube这一项。现在我要创建一个用户名，我可能会遮住这部分，你也创建自己的用户名就行。",  # 19
    "然后你要设置四位数的PIN码。可以是任何数字，但一定要简单好记，因为每次刷卡时都要用到PIN码。如你所见，我们的支票账户刚刚通过审批了，",  # 20
    "你的也应该长这个样子。我们还因为开户获得了200美元，太棒了。如你所见，借记卡会在三到五个工作日内寄到。等你从邮箱收到后，",  # 21
    "记得放进钱包好好保管，因为现在你就可以在ATM取款机、商店、任何你想买东西的地方使用它了。好，我刚登录了，这就是你的银行账户界面的样子。",  # 22
    "这是我的支票账户。就像我说的，支票账户就是你的借记卡，两者是一回事。你的雇主会把工资存到这个账户里。",  # 23
    "然后你可以用这个账户做任何事——买菜、在网上买鞋。所有的钱都从这里进出。当然，如果我想办信用卡，方式也差不多，",  # 24
    "但那是另一个视频的内容。如果我办了信用卡，它会是一个独立的账户。信用卡的余额不会是零，而是他们让你借的额度。比如如果我获批了10,000美元，",  # 25
    "屏幕上就会显示10,000美元。当我买东西时，余额就会从这个数字里扣。然后用借记卡的话，我需要从雇主或其他地方存钱进去，",  # 26
    "然后把钱transfer（转账）到信用卡来还清，直到恢复10,000美元的额度。非常简单。希望这个视频帮到了你们开自己的银行账户。记住如果你未满18岁，就和父母一起去。",  # 27
    "流程完全一样。另外告诉你们，如果你和父母有共同的银行账户，等你满18岁时，你可以打电话给银行说：嘿，我18岁了，想要自己的账户。你们能签一个release form（解除授权表）吗？",  # 28
    "Wait, cue 29 should be at index 29. Let me recount.",  # placeholder - will fix below
    "这样他们基本上会把你父母从那个账户移除，或者给你开一个新的。我建议保留和父母的共同账户，这样万一你需要钱，他们可以转给你。",  # 30
    "但至少你还有一个独立账户，里面放你自己的钱，他们碰不到。你的钱可以安全地存在那里。我15岁时就是这么做的。不过现在我有三个账户了。",  # 31
    "是的，大概就是这样。希望这个视频对你们有帮助。如果有更多问题，在下面留言。如果视频帮到了你，请点赞，这对我的频道很有帮助。如果你想看更多这样的视频，就订阅我。",  # 32
    "除此之外，我们TikTok上见，直播上见。我在YouTube上直播打游戏，中部时间晚上7点。好了，下个视频见，拜拜。",  # 33 -- wait this is index 32 for 33 cues (0-32)
]

# Fix: I have 34 translations for 33 cues. The placeholder at index 29 is wrong.
# Let me rebuild properly.

translations = [
    "你想开一个银行账户？太好了，因为今天我要告诉你开银行账户到底是什么意思。我会解释借记卡、信用卡，还会在电脑上一步步演示如何开户。",  # 0
    "这就是为什么我坐在这里……不，其实是绿幕，但我会用它来一步步带你们操作，非常简单。让我们开始吧。",  # 1
    "好的，我希望你们打开Chase银行的网站或者你喜欢的任何银行。我就喜欢Chase。我来说说我们具体要做什么。",  # 2
    "我们要开的是一个checking account（支票账户）或者叫debit account（借记账户），两者是同一个东西。如果你不知道什么是借记账户，它基本上就是一个可以用来购物的账户，",  # 3
    "你会用到一种叫debit card（借记卡）的东西。这是我的借记卡，请别偷我的信息。开了支票账户后，他们会把借记卡邮寄给你。你就可以拿着它去商店消费，",  # 4
    "当你有了工作后，雇主会把工资存入这个支票账户。这样你就可以花钱、享受支票账户带来的各种便利了，对吧？",  # 5
    "还有一种东西叫credit card（信用卡），对吧？比如这是我的信用卡，Navy Federal信用卡。它和支票账户不太一样。",  # 6
    "更像是你账户里有一笔额度，你随时可以使用，但用了之后你必须pay that balance back（把钱还回去）。现在让我一步步教你怎么开自己的银行账户。",  # 7
    "我们现在在Chase网站上。记住，你可以选择任何银行。我喜欢Chase。主页上写着开新支票账户送200美元，我们就点「开户」。",  # 8
    "顺便说一下，这不是广告，我只是想教你们一些知识。好的，点这里开户。开户并不难，它会要求你提供social security number（社会安全号）、驾照或州ID。",  # 9
    "就长这个样子。如果你没有，可以在UPS办事处轻松办一个。这是我的，就这样。你也可以用社会安全号。我不能告诉你们我的号码，",  # 10
    "因为你们真的会偷我的信息。如果你未满18岁，也可以开银行账户。方法如下：这里有一个添加joint applicant（联名申请人）的选项。",  # 11
    "意思是如果你想在18岁以下开银行账户，你的父母需要在这一步替你申请。如果你父母已满18岁——显然他们肯定满了，",  # 12
    "不然就太奇怪了——他们会和你一起去银行，或者在网上操作，把你添加为联名申请人。这样即使你只有15岁，你也能拥有自己的银行账户。",  # 13
    "太酷了。但如果不行的话，你必须年满18岁才能自己开户。很遗憾，如果你未满18岁，没有其他方式开户。",  # 14
    "有一些很奇怪的App可以试试，但我真的不放心把个人信息交给它们。然后你只需要填写这些信息，接着它会问你是否是美国公民。你显然在美国，",  # 15
    "就选「是」。如果你不是美国人，也可以开户，只是需要选「否」然后完成额外步骤。然后需要输入你的社会安全号。",  # 16
    "通常是九位数。你可以让父母把卡给你，或者直接告诉你号码。如果你没有社会安全号就奇怪了，在美国每个人都应该有。接下来它会要求提供身份证件。",  # 17
    "我就用驾照。关于财务状况的问题——大家别紧张，这个调查不重要。我就填我是一名学生兼企业主。",  # 18
    "我就填表演艺术公司，因为选项里根本没有YouTube这一项。现在要创建用户名，我可能会遮住这部分，你也创建自己的用户名就行。",  # 19
    "然后你要设置four digit pin（四位数PIN码）。可以是任何数字，但一定要简单好记，因为每次刷卡时都要用到PIN码。如你所见，我们的支票账户已经通过审批了，",  # 20
    "你的也应该长这个样子。我们还因为开户获得了200美元，太棒了。如你所见，借记卡会在三到五个工作日内（three to five business days）寄到。等你从邮箱收到后，",  # 21
    "记得放进钱包好好保管，因为现在你就可以在ATM取款机、商店、任何你想买东西的地方使用它了。好，我刚登录了，这就是你的银行账户界面的样子。",  # 22
    "这是我的支票账户。就像我说的，支票账户就是你的借记卡，两者是一回事。你的雇主会把工资存到这个账户里。",  # 23
    "然后你可以用这个账户做任何事——买菜、在网上买鞋。所有的钱都从这里进出。当然，如果我想办信用卡，方式也差不多，",  # 24
    "但那是另一个视频的内容。如果我办了信用卡，它会是一个独立的账户。信用卡的余额不会是零，而是银行让你借的额度。比如如果我获批了10,000美元，",  # 25
    "屏幕上就会显示10,000美元。当我买东西时，就会从这个余额里扣。然后用借记卡的话，我需要从雇主或其他地方存钱进去，",  # 26
    "然后把钱transfer（转账）到信用卡来还清，直到恢复10,000美元的额度。非常简单。希望这个视频帮到你们开自己的银行账户。记住如果未满18岁，就和父母一起去。",  # 27
    "流程完全一样。另外告诉你们，如果你和父母有共同的银行账户，等你满18岁时，你可以打电话给银行说：嘿，我18岁了，想要自己的账户。你们能签一个release form（解除授权表）吗？",  # 28
    "这样他们基本上会把你父母从那个账户移除，或者给你开一个新的。我建议保留和父母的共同账户，这样万一你需要钱，他们可以转给你。",  # 29
    "但至少你还有一个独立账户，里面放你自己的钱，他们碰不到。你的钱可以安全地存在那里。我15岁时就是这么做的。不过现在我有三个账户了。",  # 30
    "是的，大概就是这样。希望这个视频对你们有帮助。如果有更多问题，在下面留言。如果视频帮到了你，请点赞，这对我的频道很有帮助。订阅我看更多这类视频。",  # 31
    "除此之外，我们TikTok上见，直播上见。我在YouTube上直播打游戏，中部时间晚上7点。好了，下个视频见，拜拜。",  # 32
]

key_data = {
    3: ("checking account", "支票账户，也叫 debit account（借记账户），两者是同一个东西。这是美国最基础的银行账户类型，用于日常消费和接收工资。开户后银行会寄一张 debit card（借记卡）给你。", "checking account"),
    4: ("debit card", "借记卡。开 checking account 后银行邮寄给你的消费卡。使用时直接从账户余额扣款（不是借钱）。可在商店刷卡、ATM取现。与 credit card 的区别：debit card 花的是你自己的钱。", "debit card"),
    6: ("credit card", "信用卡。与 checking account 不同，信用卡是银行给你的一笔信用额度（credit limit），你先花后还。每月需还清余额（pay the balance back），否则会产生利息。", "credit card"),
    7: ("pay that balance back", "还清余额/还款。使用信用卡消费后必须偿还的金额。balance 在银行语境中指「余额」。pay back = 偿还。例：You need to pay the balance back by the due date to avoid interest charges.", "pay that balance back"),
    9: ("social security number", "社会安全号码（简称SSN）。美国的个人身份识别号码，九位数字，开银行账户、报税、就业都需要。相当于中国的身份证号。留学生也会被分配一个。", "social security number"),
    11: ("joint applicant", "联名申请人。未满18岁的人开银行账户时，需要父母作为 joint applicant 一起申请。联名账户（joint account）意味着父母也可以查看和管理这个账户。", "joint applicant"),
    20: ("four digit pin", "四位数PIN码。Personal Identification Number的缩写。在商店刷卡或ATM取款时需要输入。一定要设一个好记的数字，但不要太简单（如1234）以防被盗。", "four digit pin"),
    21: ("three to five business days", "三到五个工作日。银行寄送借记卡的标准时间。business days 指工作日（周一至周五），不包括周末和节假日。例：Your new card will arrive in three to five business days.", "三到五个工作日"),
    22: ("ATMs", "自动取款机（Automated Teller Machine）。可以用借记卡取现金、查余额、存款。注意：使用其他银行的ATM可能会收取手续费（ATM fee）。", "ATM取款机"),
    27: ("transfer", "转账。把钱从一个账户转到另一个账户。视频中指从 checking account 转钱到 credit card 账户来还信用卡。也可用于朋友间转账（transfer money to someone）。", "transfer"),
    28: ("release form", "解除授权表。年满18岁后想将联名账户变为个人账户时，需要签署的文件。签署后父母将不再有权访问该账户。也可以选择保留联名账户同时开一个新的独立账户。", "release form"),
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
    "sceneContext": "The user is a young person visiting a bank to open their first checking account. They are speaking with a bank representative who will guide them through the account opening process, explain the difference between debit and credit cards, and help them understand banking basics like PINs, transfers, and joint accounts.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "open a bank account", "meaningZh": "开银行账户", "usage": "The basic phrase for starting a new account at a bank", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "checking account", "meaningZh": "支票账户/借记账户", "usage": "The most common type of bank account for daily spending and receiving salary", "register": "professional", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "debit card", "meaningZh": "借记卡", "usage": "A card linked to your checking account that deducts money directly when you pay", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "credit card", "meaningZh": "信用卡", "usage": "A card that lets you borrow money up to a credit limit, which must be paid back", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "social security number", "meaningZh": "社会安全号码", "usage": "A nine-digit identification number required for banking, taxes, and employment in the US", "register": "professional", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "joint applicant", "meaningZh": "联名申请人", "usage": "A co-applicant needed when someone under 18 wants to open an account", "register": "professional", "speakerRole": "passive"},
        {"expression": "pay the balance back", "meaningZh": "还清余额", "usage": "Repaying the amount spent on a credit card", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "transfer money", "meaningZh": "转账", "usage": "Moving money from one account to another", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "business days", "meaningZh": "工作日", "usage": "Monday through Friday, excluding weekends and holidays — used for delivery and processing times", "register": "professional", "speakerRole": "passive"},
        {"expression": "PIN number", "meaningZh": "PIN码/密码", "usage": "A four-digit personal identification number used at ATMs and stores", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
    ],
    "roleSetup": {"name": "Jason", "identity": "Bank account representative at a major bank", "personality": "friendly, patient, casual", "accent": "American"},
    "complications": {
        "medium": [
            "The user confuses debit card and credit card when explaining what type of account they want",
            "The user doesn't have their social security number available and needs to ask what alternatives are accepted"
        ],
        "hard": [
            "The user is under 18 and needs to explain the joint applicant process while asking about account independence at age 18",
            "The user needs to understand and explain the difference between checking account balance and credit card balance/limit"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "混淆 checking account（支票账户）和 savings account（储蓄账户）——本视频主要讲的是 checking account",
        "不理解 debit card 和 credit card 的区别——debit card 花自己的钱，credit card 是借银行的钱",
        "把 PIN 说成 password——在银行语境中，ATM 和刷卡用的是 PIN，不是 password",
        "不知道 business days 不包括周末——说「五天后到」但实际可能要一周"
    ],
    "culturalNotes": "在美国，年满18岁后开银行账户是成年的重要标志之一。大多数银行（如Chase、Bank of America、Wells Fargo）都提供免费的 checking account。未满18岁需要父母作为 joint applicant 共同开户。Social Security Number（SSN）是美国银行开户的必备文件，留学生到美国后应尽快申请。",
    "country": "US"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
