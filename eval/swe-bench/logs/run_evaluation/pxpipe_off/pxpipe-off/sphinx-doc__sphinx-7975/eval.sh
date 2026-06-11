#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 4ec6cbe341fd84468c448e20082c778043bbea4b
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .[test]
git checkout 4ec6cbe341fd84468c448e20082c778043bbea4b tests/test_environment_indexentries.py
git apply -v - <<'EOF_114329324912'
diff --git a/tests/test_environment_indexentries.py b/tests/test_environment_indexentries.py
--- a/tests/test_environment_indexentries.py
+++ b/tests/test_environment_indexentries.py
@@ -25,12 +25,14 @@ def test_create_single_index(app):
             ".. index:: ёлка\n"
             ".. index:: ‏תירבע‎\n"
             ".. index:: 9-symbol\n"
-            ".. index:: &-symbol\n")
+            ".. index:: &-symbol\n"
+            ".. index:: £100\n")
     restructuredtext.parse(app, text)
     index = IndexEntries(app.env).create_index(app.builder)
     assert len(index) == 6
     assert index[0] == ('Symbols', [('&-symbol', [[('', '#index-9')], [], None]),
-                                    ('9-symbol', [[('', '#index-8')], [], None])])
+                                    ('9-symbol', [[('', '#index-8')], [], None]),
+                                    ('£100', [[('', '#index-10')], [], None])])
     assert index[1] == ('D', [('docutils', [[('', '#index-0')], [], None])])
     assert index[2] == ('P', [('pip', [[], [('install', [('', '#index-2')]),
                                             ('upgrade', [('', '#index-3')])], None]),

EOF_114329324912
: '>>>>> Start Test Output'
tox --current-env -epy39 -v -- tests/test_environment_indexentries.py
: '>>>>> End Test Output'
git checkout 4ec6cbe341fd84468c448e20082c778043bbea4b tests/test_environment_indexentries.py
