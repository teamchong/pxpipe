#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 26f690961a52946dd2f53bf0fdd4264b2ae5be90
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -v --no-use-pep517 --no-build-isolation -e .
git checkout 26f690961a52946dd2f53bf0fdd4264b2ae5be90 sklearn/feature_selection/tests/test_mutual_info.py
git apply -v - <<'EOF_114329324912'
diff --git a/sklearn/feature_selection/tests/test_mutual_info.py b/sklearn/feature_selection/tests/test_mutual_info.py
--- a/sklearn/feature_selection/tests/test_mutual_info.py
+++ b/sklearn/feature_selection/tests/test_mutual_info.py
@@ -183,18 +183,26 @@ def test_mutual_info_options():
     X_csr = csr_matrix(X)
 
     for mutual_info in (mutual_info_regression, mutual_info_classif):
-        assert_raises(ValueError, mutual_info_regression, X_csr, y,
+        assert_raises(ValueError, mutual_info, X_csr, y,
                       discrete_features=False)
+        assert_raises(ValueError, mutual_info, X, y,
+                      discrete_features='manual')
+        assert_raises(ValueError, mutual_info, X_csr, y,
+                      discrete_features=[True, False, True])
+        assert_raises(IndexError, mutual_info, X, y,
+                      discrete_features=[True, False, True, False])
+        assert_raises(IndexError, mutual_info, X, y, discrete_features=[1, 4])
 
         mi_1 = mutual_info(X, y, discrete_features='auto', random_state=0)
         mi_2 = mutual_info(X, y, discrete_features=False, random_state=0)
-
-        mi_3 = mutual_info(X_csr, y, discrete_features='auto',
-                           random_state=0)
-        mi_4 = mutual_info(X_csr, y, discrete_features=True,
+        mi_3 = mutual_info(X_csr, y, discrete_features='auto', random_state=0)
+        mi_4 = mutual_info(X_csr, y, discrete_features=True, random_state=0)
+        mi_5 = mutual_info(X, y, discrete_features=[True, False, True],
                            random_state=0)
+        mi_6 = mutual_info(X, y, discrete_features=[0, 2], random_state=0)
 
         assert_array_equal(mi_1, mi_2)
         assert_array_equal(mi_3, mi_4)
+        assert_array_equal(mi_5, mi_6)
 
     assert not np.allclose(mi_1, mi_3)

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA sklearn/feature_selection/tests/test_mutual_info.py
: '>>>>> End Test Output'
git checkout 26f690961a52946dd2f53bf0fdd4264b2ae5be90 sklearn/feature_selection/tests/test_mutual_info.py
