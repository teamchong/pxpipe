# Novel arithmetic word problems with RANDOM numbers — cannot be in any training set.
# Simple arithmetic (model won't err on the math), large random numbers (so a wrong
# answer == a misread digit). This isolates READING from memory/reasoning.
import random, json
random.seed(20260531)
N = 100

def t_sum3():
    a,b,c = (random.randint(1000,9999) for _ in range(3))
    return (f"A factory produced {a} units on Monday, {b} units on Tuesday, and {c} units on Wednesday. "
            f"How many units did it produce in total over the three days?", a+b+c)
def t_subadd():
    a=random.randint(3000,9999); b=random.randint(100,999); c=random.randint(100,999)
    return (f"A reservoir contains {a} gallons of water. {b} gallons are pumped out for irrigation, "
            f"and later {c} gallons of rainwater flow in. How many gallons are in the reservoir now?", a-b+c)
def t_muladd():
    a=random.randint(11,99); b=random.randint(11,99); c=random.randint(100,999)
    return (f"A warehouse has {a} shelves, each holding {b} boxes, plus {c} loose boxes on the floor. "
            f"How many boxes are in the warehouse in total?", a*b+c)
def t_diff():
    a=random.randint(5000,9999); b=random.randint(1000,4999)
    return (f"A stadium has {a} seats. {b} of them are already sold. How many seats remain unsold?", a-b)

ts = [t_sum3, t_subadd, t_muladd, t_diff]
with open('/tmp/novel.jsonl','w') as f:
    for _ in range(N):
        q,ans = random.choice(ts)()
        f.write(json.dumps({"question": q, "answer": f"#### {ans}"})+"\n")
print(f"wrote {N} novel random-number problems")
