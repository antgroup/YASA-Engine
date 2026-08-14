Tiny fixtures for guarded Python no-init method dispatch validation.

Expected outcomes:
- no_init_direct_T.py: one finding, direct no-init instance method to sink.
- no_init_local_hop_T.py: one finding, no-init instance method with one local self-call hop to sink.
- no_init_untainted_F.py: zero findings, no-init method uses a safe constant.
- no_init_dynamic_unknown_F.py: zero findings, guarded fallback must not execute dynamic getattr calls.
- explicit_init_T.py: one finding, existing explicit __init__ object behavior remains unchanged.

Run serially only; do not combine with project/STC/benchmark scans.
