#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 5c4595267ccd3daf78f5fd05693b7ecbcd575c1e
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .
git checkout 5c4595267ccd3daf78f5fd05693b7ecbcd575c1e lib/matplotlib/tests/test_legend.py
git apply -v - <<'EOF_114329324912'
diff --git a/lib/matplotlib/tests/test_legend.py b/lib/matplotlib/tests/test_legend.py
--- a/lib/matplotlib/tests/test_legend.py
+++ b/lib/matplotlib/tests/test_legend.py
@@ -783,6 +783,14 @@ def test_get_set_draggable():
     assert not legend.get_draggable()
 
 
+@pytest.mark.parametrize('draggable', (True, False))
+def test_legend_draggable(draggable):
+    fig, ax = plt.subplots()
+    ax.plot(range(10), label='shabnams')
+    leg = ax.legend(draggable=draggable)
+    assert leg.get_draggable() is draggable
+
+
 def test_alpha_handles():
     x, n, hh = plt.hist([1, 2, 3], alpha=0.25, label='data', color='red')
     legend = plt.legend()

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA lib/matplotlib/tests/test_legend.py
: '>>>>> End Test Output'
git checkout 5c4595267ccd3daf78f5fd05693b7ecbcd575c1e lib/matplotlib/tests/test_legend.py
