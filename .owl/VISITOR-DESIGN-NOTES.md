# Visitor-jyth Design Notes

## Memory System Variants

### Design 1: FragmentationMemory (Current, Zero-Cost)
- Takes random blocks of memory
- Folds into page reference
- No LLM summarization
- Pluggable fragmenter (RandomSamplingFragmenter)
- **Cost**: $0
- **Speed**: Instant
- **Quality**: Lossy (stochastic sampling)
- **Status**: ✅ Implemented in gro

### Design 2: Hybrid (Fragmentation + Summarization)
- Takes random blocks of memory
- Folds into page reference
- **Added**: Summarization of selected blocks
- **Cost**: ~$0.05-0.10 per page (Haiku summarization)
- **Speed**: Slower (LLM call)
- **Quality**: Better recall (samples + summaries)
- **Status**: 🔄 Proposed, not yet implemented

## Questions for jc
1. Is Design 1 (FragmentationMemory) sufficient for current use cases?
2. Should we implement Design 2 as optional variant?
3. When would a user prefer hybrid over pure Virtual (lane-based summarization)?

## Trade-offs
| Aspect | Design 1 | Design 2 | VirtualMemory |
|--------|----------|----------|---------------|
| Cost | $0 | ~$0.05/page | ~$0.50/page |
| Speed | Instant | 5-10s | 5-10s |
| Recall | Good | Better | Best |
| Complexity | Simple | Medium | High |
| Lane aware | No | Possibly | Yes |

## Implementation Notes
- Design 2 would extend FragmentationMemory
- Add optional `summarizeSelected: boolean` flag
- Reuse VirtualMemory's summarization queue
- Ensure importance weights carry through (🧠 markers)
