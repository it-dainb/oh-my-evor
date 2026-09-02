#!/usr/bin/env python3
"""Build the Author A scenario corpus:  python3 evals/bench/tool/authoring/build.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate
generate.build()
